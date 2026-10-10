import { createHash } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { requirePipeline } from "../mcp/tool-policy.js";
export const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function exact(input, keys) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !keys.includes(k))
  )
    throw assistantProblem("invalid");
}
export class AssistantAccess {
  constructor(services) {
    this.s = services;
    this.db = services.assistants.store.db;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_access(assistant_id TEXT PRIMARY KEY REFERENCES assistants(id),body TEXT NOT NULL)",
    );
  }
  eligible(id) {
    const a = this.s.assistants.store.getAssistant(id);
    if (a.archivedAt || (a.teamMemberId && a.lifetime !== "permanent"))
      throw assistantProblem("invalid", 403);
    return a;
  }
  get(id) {
    this.s.assistants.store.getAssistant(id);
    const row = this.db
      .prepare("SELECT body FROM assistant_access WHERE assistant_id=?")
      .get(id);
    return row
      ? JSON.parse(row.body)
      : {
          revision: 0,
          projectIds: [],
          pipelineIds: [],
          memoryWrite: false,
          autonomous: false,
          publish: false,
          accountIds: [],
          connectionIds: [],
          definitions: {},
        };
  }
  definition(id) {
    const d = this.s.pipelineDefinitions,
      pipeline = d.getPipeline(id);
    const profiles = pipeline.graph.nodes
      .filter((n) => n.kind === "profile")
      .map((n) => d.getProfile(n.profileId));
    return { pipeline, profiles, hash: digest({ pipeline, profiles }) };
  }
  catalog() {
    return {
      projects: this.s.memory.projects().projects.map(({ id, name }) => ({ id, name })),
      pipelines: this.s.pipelineDefinitions
        .listPipelines()
        .map(({ id, name }) => ({ id, name })),
    };
  }
  save(id, input, revision) {
    this.eligible(id);
    if (this.s.assistants.maintenance) throw assistantProblem("active", 409);
    exact(input, ["projectIds", "pipelineIds", "memoryWrite", "autonomous", "publish"]);
    const old = this.get(id);
    if (old.revision !== revision) throw assistantProblem("conflict", 409);
    for (const key of ["projectIds", "pipelineIds"]) {
      if (
        !Array.isArray(input[key]) ||
        input[key].length > 100 ||
        new Set(input[key]).size !== input[key].length
      )
        throw assistantProblem("invalid");
      for (const value of input[key]) textValue(value, 100);
    }
    for (const key of ["memoryWrite", "autonomous", "publish"])
      if (typeof input[key] !== "boolean") throw assistantProblem("invalid");
    for (const project of input.projectIds) this.s.memory.project(project);
    const definitions = {},
      accountIds = new Set(),
      connectionIds = new Set();
    for (const pipelineId of input.pipelineIds) {
      const def = this.definition(pipelineId);
      definitions[pipelineId] = def.hash;
      for (const p of def.profiles) {
        textValue(p.config.accountId, 100);
        accountIds.add(p.config.accountId);
        if (p.config.providerConnectionId)
          connectionIds.add(p.config.providerConnectionId);
      }
    }
    const next = {
      ...input,
      revision: revision + 1,
      accountIds: [...accountIds],
      connectionIds: [...connectionIds],
      definitions,
    };
    this.db
      .prepare(
        "INSERT INTO assistant_access VALUES(?,?) ON CONFLICT(assistant_id) DO UPDATE SET body=excluded.body",
      )
      .run(id, JSON.stringify(next));
    this.s.assistants.changed();
    return next;
  }
  authorize(id, projectId, pipelineId, revision) {
    this.eligible(id);
    const policy = this.get(id);
    if (
      !policy.projectIds.includes(projectId) ||
      (revision !== undefined && revision !== policy.revision)
    )
      throw assistantProblem("invalid", 403);
    this.s.memory.project(projectId);
    if (pipelineId) {
      if (!policy.pipelineIds.includes(pipelineId))
        throw assistantProblem("invalid", 403);
      const def = this.definition(pipelineId);
      if (policy.definitions[pipelineId] !== def.hash)
        throw assistantProblem("conflict", 409);
      requirePipeline(this.grant(id), def.pipeline, this.s.pipelineDefinitions, {
        executing: true,
      });
    }
    return policy;
  }
  grant(id) {
    const p = this.get(id);
    return {
      ...p,
      id: `assistant-${id}`,
      clientId: `assistant-${id}`,
      ownedRunsOnly: true,
      scopes: [
        "catalog:read",
        "runs:read",
        "runs:start",
        "runs:cancel",
        ...(p.publish ? ["runs:publish"] : []),
      ],
    };
  }
}
