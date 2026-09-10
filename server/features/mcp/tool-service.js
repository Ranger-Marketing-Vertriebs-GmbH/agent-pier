import { problem } from "../../lib/storage.js";
import { projectScope } from "../memory/project-scope.js";
import { toolSchemas } from "./tool-schemas.js";
import { StartRequests } from "./start-requests.js";
import {
  requireScope,
  requireResource,
  requireProfile,
  requirePipeline,
  requireRun,
  visible,
  pageItems,
  runSummary,
} from "./tool-policy.js";

export class McpTools {
  constructor(services) {
    this.services = services;
    this.requests = new StartRequests(services.config.dataDir);
  }
  list(grant) {
    return Object.entries(toolSchemas).filter(([, tool]) =>
      grant.scopes.includes(tool.scope),
    );
  }
  async call(name, input, grant, resolveGrant) {
    const descriptor = toolSchemas[name];
    if (!descriptor || !Object.hasOwn(toolSchemas, name))
      throw problem("Unknown MCP tool.", 404);
    requireScope(grant, descriptor.scope);
    const result = descriptor.schema.safeParse(input);
    if (!result.success)
      throw problem("Invalid MCP tool arguments. Check the tool input schema.", 400);
    const execute = () => {
      const current = resolveGrant ? resolveGrant() : grant;
      requireScope(current, descriptor.scope);
      return this.perform(name, result.data, current, resolveGrant);
    };
    return descriptor.readOnly ? execute() : this.services.mutationBarrier.run(execute);
  }
  audit(action, resourceType, resourceId, grant, projectId) {
    this.services.audit.append({
      action,
      resourceType,
      resourceId,
      source: "mcp",
      outcome: "success",
      ...(projectId ? { projectId } : {}),
      details: { grantId: grant.id, clientId: grant.clientId },
    });
  }
  profile(id, grant) {
    const profile = this.services.pipelineDefinitions.getProfile(id);
    requireProfile(grant, profile);
    return profile;
  }
  pipeline(id, grant, executing = false) {
    const pipeline = this.services.pipelineDefinitions.getPipeline(id);
    requirePipeline(grant, pipeline, this.services.pipelineDefinitions, { executing });
    return pipeline;
  }
  run(id, grant) {
    const run = this.services.pipelines.get(id);
    requireRun(grant, run, this.requests.owner(id));
    return run;
  }
  summary(run) {
    const endpoint = this.services.mcpAccess?.status().mcpUrl;
    return runSummary(
      run,
      endpoint ? new URL(endpoint).origin : this.services.config.remoteUrl,
    );
  }
  replayStart(grant, requestId, input) {
    const previous = this.requests.get(grant.id, requestId, input);
    if (previous) {
      let run;
      try {
        run = this.services.pipelines.get(previous.runId);
      } catch (error) {
        if (error.status !== 404) throw error;
        throw problem(
          "This start was interrupted before a run could be confirmed. Inspect AgentPier before submitting a new request ID.",
          409,
        );
      }
      requireRun(grant, run, previous);
      return { run: this.summary(run), replayed: true };
    }
  }
  async start(args, grant, resolveGrant) {
    const { pipelineId, projectId, task, baseBranch, requestId } = args;
    requireResource(grant, "projectIds", projectId);
    const input = { pipelineId, projectId, task, baseBranch: baseBranch || null };
    const previous = this.replayStart(grant, requestId, input);
    if (previous) return previous;
    const project = this.services.memory.project(projectId);
    const currentProject = await projectScope(project.cwd);
    if (currentProject.id !== projectId)
      throw problem(
        "The registered project identity changed. Register and authorize the current project before starting a run.",
        409,
      );
    if (resolveGrant) grant = resolveGrant();
    requireScope(grant, "runs:start");
    requireResource(grant, "projectIds", projectId);
    const raced = this.replayStart(grant, requestId, input);
    if (raced) return raced;
    this.pipeline(pipelineId, grant, true);
    const receipt = this.requests.reserve(grant.id, requestId, input);
    const run = await this.services.pipelines.start(
      { pipelineId, cwd: project.cwd, task, ...(baseBranch ? { baseBranch } : {}) },
      { id: receipt.runId, expectedProjectId: projectId },
    );
    this.audit("pipeline.started", "pipeline", run.id, grant, projectId);
    return { run: this.summary(run), replayed: false };
  }
  async perform(name, args, grant, resolveGrant) {
    const {
      memory,
      accounts,
      providerConnections,
      providerCatalog,
      pipelineDefinitions: definitions,
      pipelines,
    } = this.services;
    switch (name) {
      case "projects_list":
        return pageItems(
          memory
            .projects()
            .projects.filter((p) => grant.projectIds.includes(p.id))
            .map(({ id, name, kind }) => ({ id, name, kind })),
          args,
        );
      case "accounts_list":
        return {
          ...pageItems(
            accounts
              .list()
              .filter((a) => grant.accountIds.includes(a.id) && a.tool !== "shell")
              .map(({ id, name, tool, kind, provider }) => ({
                id,
                name,
                tool,
                kind,
                ...(provider ? { provider } : {}),
              })),
            args,
          ),
          connections: providerConnections
            .list()
            .filter((c) => grant.connectionIds.includes(c.id))
            .map(({ id, name, providerId, tools }) => ({ id, name, providerId, tools })),
        };
      case "models_list": {
        requireResource(grant, "connectionIds", args.connectionId);
        const connection = providerConnections.get(args.connectionId);
        if (!connection.tools.includes(args.tool))
          throw problem("The provider connection does not support that CLI.", 400);
        if (
          !accounts
            .list()
            .some(
              (account) =>
                grant.accountIds.includes(account.id) && account.tool === args.tool,
            )
        )
          throw problem("No account for this CLI is authorized.", 403);
        const models = providerCatalog.list({
          providerId: connection.providerId,
          tool: args.tool,
        });
        return pageItems(
          models.map((model) => ({ ...model, name: model.label })),
          args,
        );
      }
      case "profiles_list":
        return pageItems(
          definitions
            .listProfiles()
            .filter((profile) => visible(() => requireProfile(grant, profile))),
          args,
        );
      case "profile_get":
        return { profile: this.profile(args.id, grant) };
      case "profile_save": {
        if (args.id) this.profile(args.id, grant);
        requireProfile(grant, args.profile);
        const profile = definitions.saveProfile(args.profile, args.id);
        this.audit(
          args.id ? "profile.updated" : "profile.created",
          "profile",
          profile.id,
          grant,
        );
        return { profile };
      }
      case "pipelines_list":
        return pageItems(
          definitions
            .listPipelines()
            .filter((pipeline) =>
              visible(() => requirePipeline(grant, pipeline, definitions)),
            ),
          args,
        );
      case "pipeline_get":
        return { pipeline: this.pipeline(args.id, grant) };
      case "pipeline_validate": {
        const graph = requirePipeline(grant, args.pipeline, definitions, {
          executing: true,
        });
        definitions.validateProfiles(graph);
        return { valid: true, graph };
      }
      case "pipeline_save": {
        if (args.id) this.pipeline(args.id, grant, true);
        requirePipeline(grant, args.pipeline, definitions, { executing: true });
        const pipeline = definitions.savePipeline(args.pipeline, args.id);
        this.audit(
          args.id ? "pipeline.updated" : "pipeline.created",
          "pipeline",
          pipeline.id,
          grant,
        );
        return { pipeline };
      }
      case "runs_list": {
        if (args.projectId) requireResource(grant, "projectIds", args.projectId);
        const runs = pipelines.store
          .all()
          .filter(
            (run) =>
              (!args.status || run.status === args.status) &&
              (!args.projectId || run.projectId === args.projectId) &&
              visible(() => requireRun(grant, run, this.requests.owner(run.id))),
          );
        return pageItems(
          runs.map((run) => this.summary(run)),
          args,
        );
      }
      case "run_start":
        return this.start(args, grant, resolveGrant);
      case "run_get":
        return { run: this.summary(this.run(args.runId, grant)) };
      case "run_cancel": {
        this.run(args.runId, grant);
        if (!grant.allResources && this.requests.owner(args.runId)?.grantId !== grant.id)
          throw problem("This grant did not start that run.", 403);
        const run = await pipelines.cancel(args.runId);
        this.audit("pipeline.cancelled", "pipeline", run.id, grant, run.projectId);
        return { run: this.summary(run) };
      }
      case "run_artifacts":
        this.run(args.runId, grant);
        return pipelines.artifacts(args.runId, args.nodeId);
      case "run_artifact":
        this.run(args.runId, grant);
        return pipelines.artifact(args.runId, args.nodeId, args.path);
      case "run_diff":
        this.run(args.runId, grant);
        return pipelines.diff(args.runId, args.nodeId);
      case "run_verification_logs":
        this.run(args.runId, grant);
        return pipelines.verifyLogs(args.runId, args.nodeId, args.stepIndex);
      default:
        throw problem("Unknown MCP tool.", 404);
    }
  }
  close() {
    this.requests.close();
  }
}
