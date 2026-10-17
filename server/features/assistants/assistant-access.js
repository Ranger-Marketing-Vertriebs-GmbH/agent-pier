import { createHash } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { requirePipeline } from "../mcp/tool-policy.js";
import { sshModes } from "./agent-ssh-origin.js";
import { personalEligible } from "./native-capabilities.js";
// The session grant limit (ssh-sessions.js) also bounds an agent's SSH hosts.
const maxSshAccesses = 30;
const byAccessId = (a, b) =>
  a.accessId < b.accessId ? -1 : a.accessId > b.accessId ? 1 : 0;
export const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/**
 * The revision pending approvals are bound to. Removing an SSH host bumps `revision`
 * (edit concurrency) but not this, so it never revokes unrelated coding or memory
 * approvals; older records without the field use `revision`.
 */
export const approvalRevision = (policy) => policy.approvalRevision ?? policy.revision;
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
      ? { sshAccesses: [], ...JSON.parse(row.body) }
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
          sshAccesses: [],
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
    const projects = this.s.memory
      .projects()
      .projects.map(({ id, name }) => ({ id, name }));
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const hosts = this.sshHosts();
    return {
      projects,
      pipelines: this.s.pipelineDefinitions
        .listPipelines()
        .map(({ id, name }) => ({ id, name })),
      // Public catalog metadata only; null tells the Work tab it could not be read.
      sshHosts:
        hosts &&
        hosts.map(({ id, name, host, port, username, hostFingerprint, projectId }) => ({
          id,
          name,
          host,
          port,
          username,
          hostFingerprint,
          projectId: projectId ?? null,
          projectName: (projectId && names.get(projectId)) || null,
        })),
    };
  }
  /**
   * Validates a policy change against `revision`; returns the record, writes nothing.
   * Projects that no longer exist (an older row merged away) are dropped instead of
   * refused and listed in `notes.removedProjectIds`, so a stale grant never blocks
   * the owner's save.
   */
  prepare(id, input, revision, notes = {}) {
    this.eligible(id);
    if (this.s.assistants.maintenance) throw assistantProblem("active", 409);
    exact(input, [
      "projectIds",
      "pipelineIds",
      "memoryWrite",
      "autonomous",
      "publish",
      "sshAccesses",
    ]);
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
    const projectIds = [];
    notes.removedProjectIds = [];
    for (const project of input.projectIds)
      (this.knownProject(project) ? projectIds : notes.removedProjectIds).push(project);
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
    return {
      ...input,
      projectIds,
      // Absent keeps the stored grants: the MCP path and older clients never send them.
      sshAccesses:
        input.sshAccesses === undefined
          ? old.sshAccesses
          : this.sshList(id, input.sshAccesses),
      revision: revision + 1,
      approvalRevision: revision + 1,
      accountIds: [...accountIds],
      connectionIds: [...connectionIds],
      definitions,
    };
  }
  knownProject(projectId) {
    try {
      this.s.memory.project(projectId);
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }
  write(id, next) {
    this.db
      .prepare(
        "INSERT INTO assistant_access VALUES(?,?) ON CONFLICT(assistant_id) DO UPDATE SET body=excluded.body",
      )
      .run(id, JSON.stringify(next));
    return next;
  }
  save(id, input, revision) {
    const before = this.get(id);
    const next = this.write(id, this.prepare(id, input, revision));
    this.auditSsh(id, before, next, "owner");
    this.s.assistants.changed();
    return next;
  }
  // A replaced SSH grant list: catalog hosts with a mode, sorted; an agent with its
  // own bot for other people never gets one (telegram-senders.js).
  sshList(id, value) {
    if (!Array.isArray(value) || value.length > maxSshAccesses)
      throw assistantProblem("invalid");
    const seen = new Set();
    const list = value.map((entry) => {
      exact(entry, ["accessId", "mode"]);
      textValue(entry.accessId, 100);
      if (!sshModes.includes(entry.mode) || seen.has(entry.accessId))
        throw assistantProblem("invalid");
      seen.add(entry.accessId);
      return { accessId: entry.accessId, mode: entry.mode };
    });
    if (!list.length) return list;
    const hosts = this.sshHosts();
    if (!hosts) throw assistantProblem("sshHostUnavailable", 503);
    if (list.some((g) => !hosts.some((h) => h.id === g.accessId)))
      throw assistantProblem("sshHostUnavailable", 409);
    if (this.s.assistantTelegramSenders?.connected(id))
      throw assistantProblem("telegramSendersSsh", 409);
    return list.sort(byAccessId);
  }
  // The SSH catalog's hosts, or null while it cannot be read (never "no hosts").
  sshHosts() {
    const store = this.s.sshManagement?.store;
    if (!store) return null;
    try {
      return store.list();
    } catch {
      return null;
    }
  }
  sshGrant(id, accessId) {
    return this.get(id).sshAccesses.find((g) => g.accessId === accessId) || null;
  }
  hasSshGrants(id) {
    try {
      return (
        personalEligible(this.s.assistants.store.getAssistant(id)) &&
        this.get(id).sshAccesses.length > 0
      );
    } catch {
      return false;
    }
  }
  /** Eligible agents with at least one SSH grant; never throws (compiles use it). */
  sshAgents() {
    try {
      return new Set(
        this.db
          .prepare("SELECT assistant_id FROM assistant_access")
          .all()
          .map((r) => r.assistant_id)
          .filter((id) => this.hasSshGrants(id)),
      );
    } catch {
      return new Set();
    }
  }
  /**
   * Removes one SSH host from every agent's grants in one transaction, together with
   * `during` (cancelling its open approvals); returns the agents whose grants changed.
   */
  revokeSsh(accessId, during = () => {}) {
    const changed = this.revokeEach(
      (before) =>
        before.sshAccesses.some((g) => g.accessId === accessId) && {
          sshAccesses: before.sshAccesses.filter((g) => g.accessId !== accessId),
        },
      during,
    );
    for (const c of changed) this.auditSsh(c.id, c.before, c.after, "host-removed");
    if (changed.length) this.s.assistants.changed();
    return changed.map((c) => c.id);
  }
  /**
   * Removes one project from every agent's grants in one transaction, together with
   * `during`; returns the changed policies. Like an SSH host removal it keeps the
   * approval revision, so approvals for other projects stay valid.
   */
  revokeProject(projectId, during = () => {}) {
    return this.revokeEach(
      (before) =>
        before.projectIds.includes(projectId) && {
          projectIds: before.projectIds.filter((id) => id !== projectId),
        },
      during,
    );
  }
  // Applies `change` (fields to replace, or false) to every stored policy at once.
  revokeEach(change, during) {
    const changed = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.db
        .prepare("SELECT assistant_id, body FROM assistant_access")
        .all()) {
        const before = { sshAccesses: [], ...JSON.parse(row.body) };
        const fields = change(before);
        if (!fields) continue;
        const after = this.write(row.assistant_id, {
          ...before,
          ...fields,
          revision: before.revision + 1,
          approvalRevision: approvalRevision(before),
        });
        changed.push({ id: row.assistant_id, before, after });
      }
      during();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return changed;
  }
  /** One `assistant.updated` record per grant change: ids and modes, never more. */
  auditSsh(id, before, after, reason) {
    const from = new Map((before?.sshAccesses || []).map((g) => [g.accessId, g.mode]));
    const to = new Map((after?.sshAccesses || []).map((g) => [g.accessId, g.mode]));
    const added = [...to.keys()].filter((k) => !from.has(k));
    const removed = [...from.keys()].filter((k) => !to.has(k));
    const modeChanged = [...to]
      .filter(([k, mode]) => from.has(k) && from.get(k) !== mode)
      .map(([accessId, mode]) => ({ accessId, from: from.get(accessId), to: mode }));
    if (!added.length && !removed.length && !modeChanged.length) return;
    try {
      this.s.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: id,
        source: "user",
        outcome: "success",
        details: {
          kind: "ssh-grants",
          revision: after.revision,
          added,
          removed,
          modeChanged,
          reason,
        },
      });
    } catch (error) {
      console.error("Agent SSH grant audit failed:", error?.message);
    }
  }
  authorize(id, projectId, pipelineId, revision) {
    this.eligible(id);
    const policy = this.get(id);
    if (
      !policy.projectIds.includes(projectId) ||
      (revision !== undefined && revision !== approvalRevision(policy))
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
