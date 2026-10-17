import { createHash } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { requirePipeline } from "../mcp/tool-policy.js";
import { sshModes } from "./agent-ssh-origin.js";
import { inheritsFromLead, personalEligible } from "./native-capabilities.js";
import { projectFileLevels } from "./member-grants.js";
// A temporary member uses its lead's SSH grants only while the lead lets its team
// members use shell and SSH (memberInheritance); it never holds grants of its own.
export const sshFromLead = (a) => inheritsFromLead(a) && a.inherited.ssh === true;
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
/**
 * Folder levels ("read" or "write") of granted projects, sorted by project id; a
 * level for a project outside `projectIds` is dropped, a malformed one refused.
 */
export function folderLevels(value = {}, projectIds = []) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw assistantProblem("invalid");
  const entries = Object.entries(value);
  if (
    entries.length > 100 ||
    entries.some(([, level]) => !projectFileLevels.includes(level))
  )
    throw assistantProblem("invalid");
  return Object.fromEntries(
    entries
      .filter(([id]) => projectIds.includes(id))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}
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
      ? { sshAccesses: [], projectFiles: {}, ...JSON.parse(row.body) }
      : {
          revision: 0,
          projectIds: [],
          projectFiles: {},
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
    // The folder path is for the owner's Work tab; agents see it only for granted
    // folders (AssistantWorkflows catalog).
    const projects = this.s.memory
      .projects()
      .projects.map(({ id, name, cwd }) => ({ id, name, path: cwd }));
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
      "projectFiles",
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
      // Folder access per granted project; absent keeps the stored levels, and a
      // project no longer granted takes its level with it.
      projectFiles: folderLevels(
        input.projectFiles === undefined ? old.projectFiles : input.projectFiles,
        projectIds,
      ),
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
  /** Saves and returns the policy with `removedProjectIds` (never stored). */
  save(id, input, revision) {
    const before = this.get(id);
    const notes = {};
    const next = this.write(id, this.prepare(id, input, revision, notes));
    this.auditSsh(id, before, next, "owner");
    this.auditProjects(id, before, next);
    this.s.assistants.changed();
    return { ...next, removedProjectIds: notes.removedProjectIds };
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
  /**
   * The agent whose SSH grants apply to `id`: itself when eligible, or a temporary
   * member's lead while the lead shares shell and SSH with its members. Refuses
   * everyone else, so every SSH check reads live whose grants count.
   */
  sshHolder(id) {
    const a = this.s.assistants.store.getAssistant(id);
    return sshFromLead(a) ? this.eligible(a.parentAssistantId) : this.eligible(id);
  }
  /** `id`'s usable grant for `accessId` (see sshHolder), or null. */
  sshGrant(id, accessId) {
    let holder;
    try {
      holder = this.sshHolder(id).id;
    } catch {
      return null;
    }
    return this.get(holder).sshAccesses.find((g) => g.accessId === accessId) || null;
  }
  hasSshGrants(id) {
    try {
      const a = this.s.assistants.store.getAssistant(id);
      const holder = sshFromLead(a) ? a.parentAssistantId : personalEligible(a) && id;
      return (
        !!holder &&
        personalEligible(this.s.assistants.store.getAssistant(holder)) &&
        this.get(holder).sshAccesses.length > 0
      );
    } catch {
      return false;
    }
  }
  /**
   * Eligible agents with at least one SSH grant, and the temporary members using
   * their lead's; never throws (compiles use it).
   */
  sshAgents() {
    try {
      const own = this.db
        .prepare("SELECT assistant_id FROM assistant_access")
        .all()
        .map((r) => r.assistant_id);
      const members = this.s.assistants.store
        .listAssistants()
        .filter(sshFromLead)
        .map((a) => a.id);
      return new Set([...own, ...members].filter((id) => this.hasSshGrants(id)));
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
          projectFiles: folderLevels(
            before.projectFiles,
            before.projectIds.filter((id) => id !== projectId),
          ),
        },
      during,
    );
  }
  holdsProject(projectId) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM assistant_access WHERE EXISTS (SELECT 1 FROM json_each(body,'$.projectIds') WHERE value=?) LIMIT 1",
        )
        .get(projectId),
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
        const before = { sshAccesses: [], projectFiles: {}, ...JSON.parse(row.body) };
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
  /**
   * One `assistant.updated` record per change of project grants or folder levels,
   * from the Work tab or the project's Agents section alike: project ids and levels.
   */
  auditProjects(id, before, after) {
    const from = new Set(before?.projectIds || []);
    const to = new Set(after?.projectIds || []);
    const added = [...to].filter((p) => !from.has(p)).sort();
    const removed = [...from].filter((p) => !to.has(p)).sort();
    const levels = (policy, p) => policy?.projectFiles?.[p] || "none";
    const folderChanged = [...new Set([...from, ...to])]
      .sort()
      .filter((p) => levels(before, p) !== levels(after, p))
      .map((p) => ({ projectId: p, from: levels(before, p), to: levels(after, p) }));
    if (!added.length && !removed.length && !folderChanged.length) return;
    try {
      this.s.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: id,
        source: "user",
        outcome: "success",
        details: {
          kind: "project-grants",
          revision: after.revision,
          added,
          removed,
          folderChanged,
        },
      });
    } catch (error) {
      console.error("Agent project grant audit failed:", error?.message);
    }
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
