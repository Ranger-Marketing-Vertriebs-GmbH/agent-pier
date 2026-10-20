import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJSON, writePrivate, problem, nameValue } from "../../lib/storage.js";
import { stageProfiles, validateGraph } from "./graph-validation.js";
import {
  boundedText,
  validateProfile,
  profileConnection,
  validateVerification,
} from "./profile-validation.js";
import { applySeeds } from "./seed-migration.js";
import { defaultRisk, validateRisk } from "./risk-rules.js";
import { tokenBudgetValue } from "./run-budget.js";

function identity(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))
    throw problem(serverMessages.pipelineGraph.invalidDefinitionId);
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
    // A new installation starts with every seed; applySeeds adds them below.
    if (this.state === null)
      this.state = {
        version: 1,
        profiles: [],
        pipelines: [],
        verification: {},
        risk: {},
        seedsApplied: [],
      };
    if (
      this.state.version !== 1 ||
      !Array.isArray(this.state.profiles) ||
      !Array.isArray(this.state.pipelines) ||
      !this.state.verification
    )
      throw new Error("Invalid pipeline definition storage");
    // Definitions written before risk rules existed have none saved.
    if (!this.state.risk || typeof this.state.risk !== "object") this.state.risk = {};
    // Seeds added or reworded since this document was written reach it once.
    if (applySeeds(this.state, new Date().toISOString()))
      writePrivate(this.file, this.state);
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
    if (!row)
      throw problem(
        kind === "profiles"
          ? serverMessages.pipelineProfiles.notFound
          : serverMessages.pipelineGraph.definitionNotFound,
        404,
      );
    return copy(row);
  }
  save(kind, body, value, id) {
    const current = id ? this.get(kind, id) : null;
    if (current && body.expectedRevision !== current.revision)
      throw problem(serverMessages.pipelineGraph.definitionChanged, 409);
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
    // Every stage's profile, each member's of a parallel group too.
    for (const node of stageProfiles(graph)) {
      let profile;
      try {
        profile = this.getProfile(node.profileId);
      } catch (error) {
        // A graph that names a missing profile is invalid input, not a missing route.
        if (error.status === 404) throw problem(error.message, status);
        throw error;
      }
      if (!profile.enabled || !profile.config.run.autonomous)
        throw problem(
          serverMessages.pipelineProfiles.mustBeEnabledAndAutonomous(profile.name),
          status,
        );
      if (profile.config.prompts.params.some((param) => param.required))
        throw problem(
          serverMessages.pipelineProfiles.noRequiredParameters(profile.name),
          status,
        );
    }
  }
  savePipeline(body, id) {
    const graph = validateGraph(body?.graph);
    this.validateProfiles(graph);
    // Optional: runs of this pipeline stop starting turns above it (see run-budget.js).
    const tokenBudget = tokenBudgetValue(body.tokenBudget);
    return this.save(
      "pipelines",
      body,
      {
        name: nameValue(body.name),
        description: boundedText(
          body.description ?? "",
          serverMessages.pipelineProfiles.invalidPipelineDescription,
          2000,
        ),
        graph,
        ...(tokenBudget ? { tokenBudget } : {}),
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
        stageProfiles(pipeline.graph).some((node) => node.profileId === id),
      )
    )
      throw problem(serverMessages.pipelineProfiles.stillReferenced, 409);
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
  /**
   * A project's risk rules: the saved ones, or the defaults while the owner has saved
   * none (`custom: false`). The defaults come along so the editor can offer them.
   */
  getRisk(projectId) {
    identity(projectId);
    const saved = Object.hasOwn(this.state.risk, projectId)
      ? this.state.risk[projectId]
      : null;
    return {
      projectId,
      ...copy(saved || defaultRisk()),
      enabled: saved?.enabled !== false,
      custom: Boolean(saved),
      defaults: defaultRisk(),
    };
  }
  /** The rules the risk gate applies to a run's project; never throws. */
  riskRules(projectId) {
    try {
      const { globs, newDependency, enabled } = this.getRisk(projectId);
      return { globs, newDependency, enabled };
    } catch {
      // A project the store cannot name is checked with the defaults, never without.
      return defaultRisk();
    }
  }
  saveRisk(projectId, body) {
    identity(projectId);
    const rules = validateRisk(body);
    const next = copy(this.state);
    next.risk[projectId] = rules;
    this.commit(next);
    return this.getRisk(projectId);
  }
  /** Moves verification steps and risk rules of a plain project folder that became a Git work tree. */
  moveVerification(fromProjectId, toProjectId) {
    if (Object.hasOwn(this.state.risk, fromProjectId)) {
      const next = copy(this.state);
      // The work tree keeps rules of its own; otherwise the folder's rules move along.
      next.risk[toProjectId] ??= next.risk[fromProjectId];
      delete next.risk[fromProjectId];
      this.commit(next);
    }
    if (!Object.hasOwn(this.state.verification, fromProjectId)) return;
    const next = copy(this.state);
    const merged = Object.hasOwn(next.verification, toProjectId)
      ? next.verification[toProjectId]
      : [];
    // Append the old steps that are missing, in order, within the step limits.
    const known = new Set(merged.map((step) => JSON.stringify(step)));
    let timeout = merged.reduce((total, step) => total + step.timeoutMs, 0);
    for (const step of next.verification[fromProjectId]) {
      const key = JSON.stringify(step);
      if (known.has(key)) continue;
      if (merged.length >= 20 || timeout + step.timeoutMs > 7200000) break;
      merged.push(step);
      known.add(key);
      timeout += step.timeoutMs;
    }
    next.verification[toProjectId] = merged;
    delete next.verification[fromProjectId];
    this.commit(next);
  }
  hasVerification(projectId) {
    return (
      Object.hasOwn(this.state.verification, projectId) ||
      Object.hasOwn(this.state.risk, projectId)
    );
  }
  snapshot(pipelineId) {
    const pipeline = this.getPipeline(pipelineId);
    this.validateProfiles(pipeline.graph, 409);
    const profiles = {};
    for (const node of stageProfiles(pipeline.graph)) {
      const profile = this.getProfile(node.profileId);
      const account = this.accounts.get(profile.config.accountId);
      if (account.tool !== profile.config.cliTool)
        throw problem(serverMessages.pipelineProfiles.accountCliChanged, 409);
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
