import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJSON, writePrivate, problem, nameValue } from "../../lib/storage.js";
import { validateGraph } from "./graph-validation.js";
import {
  boundedText,
  validateProfile,
  profileConnection,
  validateVerification,
} from "./profile-validation.js";
import { seedProfiles, seedPipeline } from "./profile-seeds.js";

function identity(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))
    throw problem("Invalid definition ID");
  return id;
}
function copy(value) {
  return structuredClone(value);
}

/** One atomic document for small editable definitions; execution history has its own store. */
export class PipelineDefinitions {
  constructor({ dataDir, accounts }) {
    this.file = path.join(dataDir, "pipelines", "definitions.json");
    this.accounts = accounts;
    this.state = readJSON(this.file, null);
    if (this.state === null) {
      const now = new Date().toISOString();
      this.state = {
        version: 1,
        profiles: seedProfiles(now),
        pipelines: [seedPipeline(now)],
        verification: {},
      };
      writePrivate(this.file, this.state);
    }
    if (
      this.state.version !== 1 ||
      !Array.isArray(this.state.profiles) ||
      !Array.isArray(this.state.pipelines) ||
      !this.state.verification
    )
      throw new Error("Invalid pipeline definition storage");
  }
  commit(next) {
    writePrivate(this.file, next);
    this.state = next;
  }
  listProfiles({ enabledOnly = false } = {}) {
    return copy(this.state.profiles.filter((profile) => !enabledOnly || profile.enabled));
  }
  getProfile(id) {
    return this.get("profiles", id);
  }
  listPipelines() {
    return copy(this.state.pipelines);
  }
  getPipeline(id) {
    return this.get("pipelines", id);
  }
  get(kind, id) {
    identity(id);
    const row = this.state[kind].find((item) => item.id === id);
    if (!row) throw problem("Pipeline definition not found", 404);
    return copy(row);
  }
  save(kind, body, value, id) {
    const current = id ? this.get(kind, id) : null;
    if (current && body.expectedRevision !== current.revision)
      throw problem("This definition changed. Reload before saving.", 409);
    const now = new Date().toISOString();
    const row = {
      ...value,
      id: current?.id ?? randomUUID(),
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      ...(kind === "profiles" ? { seedKey: current?.seedKey ?? null } : {}),
    };
    const next = copy(this.state);
    next[kind] = current
      ? next[kind].map((item) => (item.id === id ? row : item))
      : [...next[kind], row];
    this.commit(next);
    return copy(row);
  }
  saveProfile(body, id) {
    return this.save("profiles", body, validateProfile(body, this.accounts), id);
  }
  validateProfiles(graph, status = 400) {
    for (const node of graph.nodes) {
      if (node.kind !== "profile") continue;
      const profile = this.getProfile(node.profileId);
      if (!profile.enabled || !profile.config.run.autonomous)
        throw problem(
          `Pipeline profile must be enabled and autonomous: ${profile.name}`,
          status,
        );
      if (profile.config.prompts.params.some((param) => param.required))
        throw problem(
          `Pipeline profiles cannot have required parameters: ${profile.name}`,
          status,
        );
    }
  }
  savePipeline(body, id) {
    const graph = validateGraph(body?.graph);
    this.validateProfiles(graph);
    return this.save(
      "pipelines",
      body,
      {
        name: nameValue(body.name),
        description: boundedText(body.description ?? "", "pipeline description", 2000),
        graph,
      },
      id,
    );
  }
  remove(kind, id) {
    this.get(kind, id);
    const next = copy(this.state);
    next[kind] = next[kind].filter((item) => item.id !== id);
    this.commit(next);
  }
  removeProfile(id) {
    if (
      this.state.pipelines.some((pipeline) =>
        pipeline.graph.nodes.some((node) => node.profileId === id),
      )
    )
      throw problem("A pipeline still references this profile", 409);
    this.remove("profiles", id);
  }
  removePipeline(id) {
    this.remove("pipelines", id);
  }
  getVerification(projectId) {
    identity(projectId);
    return {
      projectId,
      steps: copy(
        Object.hasOwn(this.state.verification, projectId)
          ? this.state.verification[projectId]
          : [],
      ),
    };
  }
  saveVerification(projectId, body) {
    identity(projectId);
    const steps = validateVerification(body);
    const next = copy(this.state);
    next.verification[projectId] = steps;
    this.commit(next);
    return { projectId, steps: copy(steps) };
  }
  snapshot(pipelineId) {
    const pipeline = this.getPipeline(pipelineId);
    this.validateProfiles(pipeline.graph, 409);
    const profiles = {};
    for (const node of pipeline.graph.nodes) {
      if (node.kind !== "profile") continue;
      const profile = this.getProfile(node.profileId);
      const account = this.accounts.get(profile.config.accountId);
      if (account.tool !== profile.config.cliTool)
        throw problem("The profile account CLI changed", 409);
      const connection = profileConnection(profile.config, this.accounts);
      profiles[profile.id] = {
        ...profile,
        ...(connection ? { providerConnectionSnapshot: connection } : {}),
        accountSnapshot: {
          id: account.id,
          tool: account.tool,
          kind: account.kind,
          ...(account.provider ? { provider: copy(account.provider) } : {}),
        },
      };
    }
    return { pipeline, profiles };
  }
}
