import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "./application.js";
import { McpTools } from "../../server/features/mcp/tool-service.js";

/**
 * An application with two registered projects, a synthetic pipeline workspace and
 * driver, an MCP tool service and a grant for the first project.
 */
export async function setup(t) {
  const app = await applicationFixture(t);
  const services = app.application;
  const project = await services.memory.register(app.project);
  const otherPath = path.join(app.root, "other");
  await fs.mkdir(otherPath);
  const other = await services.memory.register(otherPath);
  const launches = [];
  services.pipelines.workspace = {
    async prepare({ runId }) {
      const cwd = path.join(app.root, runId);
      await fs.mkdir(cwd);
      return {
        cwd,
        projectId: project.id,
        projectRoot: app.project,
        branch: `agentpier/${runId}`,
      };
    },
  };
  services.pipelines.driver = {
    async start(input) {
      launches.push(input);
      return { sessionId: input.sessionId };
    },
    async inspect() {
      return { status: "running" };
    },
    async cancel() {},
  };
  const tools = new McpTools(services);
  t.after(() => tools.close());
  const grant = {
    id: "grant-one",
    clientId: "client-one",
    scopes: [
      "catalog:read",
      "definitions:write",
      "runs:read",
      "runs:start",
      "runs:cancel",
    ],
    projectIds: [project.id],
    accountIds: ["local-codex"],
    connectionIds: [],
  };
  const body = {
    name: "Build",
    description: "",
    enabled: true,
    phaseKey: "implementation",
    config: {
      accountId: "local-codex",
      cliTool: "codex",
      models: { available: [""], default: "" },
      prompts: { role: "", kickoff: "Build", params: [] },
      permissions: { mode: "never" },
      run: { autonomous: true },
    },
  };
  const profile = services.pipelineDefinitions.saveProfile(body);
  const pipeline = services.pipelineDefinitions.savePipeline({
    name: "Build",
    description: "",
    graph: {
      entry: "build",
      nodes: [{ id: "build", kind: "profile", profileId: profile.id }],
      edges: [],
    },
  });
  return {
    app,
    services,
    tools,
    grant,
    project,
    other,
    profile,
    pipeline,
    body,
    launches,
  };
}
