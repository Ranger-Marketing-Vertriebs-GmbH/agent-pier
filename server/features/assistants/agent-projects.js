import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDirectory } from "../../lib/directories.js";
import { projectScope } from "../memory/project-scope.js";
import { exact } from "./assistant-access.js";
import { auditAgentProject } from "./assistant-access-audit.js";
import { assistantProblem } from "./assistant-validation.js";
import { AgentProjectStore } from "./agent-project-store.js";
import { grantCreatedProject, setCreatedProjectCoding } from "./agent-project-grants.js";
import { projectCreateLimit, projectName } from "./agent-project-rules.js";
import { notifyAgentProject } from "./agent-project-notes.js";
import { directOwnerTurn, mayCreateProjects } from "./goal-turns.js";

const run = promisify(execFile);
const ownerOnly = () => assistantProblem("projectOwnerOnly", 403);
const unavailable = () => assistantProblem("projectFolderUnavailable", 409);
const optionalBoolean = (value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw assistantProblem("invalid");
  return value;
};

/** `git init` in a new project folder, with the owner's normal Git environment. */
export async function initRepository(cwd) {
  await run("git", ["init", "--quiet"], { cwd, timeout: 10000 });
}

/**
 * The owner's own turn behind a tool call (never a routine's or a hook's run, a
 * command's completion, forwarded, member or goal content) of an agent that may
 * create projects; throws otherwise. Shaped like agent-ssh-proposals.js proposalTurn.
 */
export function projectTurn(w, inv) {
  if (!inv.attemptId || inv.routine || inv.hook || inv.continuation) throw ownerOnly();
  const a = w.a,
    attempt = a.ledger.getAttempt(inv.attemptId),
    request = a.ledger.getRequest(attempt.requestId),
    conversation = a.store.getConversation(request.conversationId),
    agent = a.store.getAssistant(conversation.assistantId),
    origin = a.teams.store.context(request.id);
  if (!directOwnerTurn(origin)) throw ownerOnly();
  if (!mayCreateProjects(agent, !!w.s.assistantTelegramSenders?.connected(agent.id)))
    throw assistantProblem("projectNotEligible", 403);
  return { agent, conversation, origin };
}

/**
 * agentpier_project: an eligible agent creates an empty project folder in the owner's
 * default folder, registers it and gets it granted narrowly (agent-project-grants.js),
 * switches coding sessions for the projects it created, and lists them. It never
 * adopts an existing folder or project and never removes anything but the folder its
 * own failed call made. Each call leaves one settled `agent_project` row in the
 * agent's chat for the owner.
 */
export class AgentProjects {
  constructor(w, { gitInit = initRepository, now = Date.now } = {}) {
    this.w = w;
    this.store = new AgentProjectStore(w.a.store.db);
    // Replaceable, so a failing `git init` can be tested.
    this.gitInit = gitInit;
    this.now = now;
    this.chains = new Map();
  }
  async invoke(inv, input) {
    inv.assertCurrent();
    const turn = projectTurn(this.w, inv);
    if (input?.action === "list") {
      exact(input, ["action"]);
      return this.list(turn.agent);
    }
    if (input?.action === "create") {
      exact(input, ["action", "name", "git", "coding"]);
      const fields = {
        name: projectName(input.name),
        git: optionalBoolean(input.git, true),
        coding: optionalBoolean(input.coding, false),
      };
      return this.once(inv, turn, () => this.create(inv, turn, fields));
    }
    if (input?.action === "coding") {
      exact(input, ["action", "projectId", "enabled"]);
      if (typeof input.projectId !== "string" || typeof input.enabled !== "boolean")
        throw assistantProblem("invalid");
      return this.once(inv, turn, () =>
        this.coding(inv, turn, input.projectId, input.enabled),
      );
    }
    throw assistantProblem("invalid");
  }
  // One change at a time per agent (the limit and the name check see the previous
  // call's result); a retried call returns its first result.
  once(inv, turn, change) {
    const id = turn.agent.id;
    const next = (this.chains.get(id) || Promise.resolve()).then(() => {
      inv.assertCurrent();
      const prior = this.w.store.byKey(this.key(inv));
      return prior ? prior.payload.result : change();
    });
    const tail = next.catch(() => {});
    this.chains.set(id, tail);
    tail.then(() => this.chains.get(id) === tail && this.chains.delete(id));
    return next;
  }
  key(inv) {
    return `agent-project:${inv.attemptId}:${inv.toolCallId}`;
  }
  async create(inv, { agent, conversation }, { name, git, coding }) {
    const w = this.w;
    projectCreateLimit(this.store.times(agent.id), this.now());
    const parent = await this.parent();
    let target, made;
    try {
      target = (await createDirectory(parent, name)).path;
      made = await fs.lstat(target, { bigint: true });
    } catch (error) {
      throw error.status === 409 ? assistantProblem("projectExists", 409) : unavailable();
    }
    // From here on a failure removes this folder, which this call made, and everything
    // the call recorded for it: the grant, the creation record and the registration
    // (ProjectMemory#removeEmpty; the project is fresh, so it holds nothing yet).
    let project = null,
      recorded = false,
      granted = false;
    try {
      // The folder must still be the one this call made, never a link put in its place.
      await this.unchanged(target, made);
      if (git)
        try {
          await this.gitInit(target);
        } catch {
          throw unavailable();
        }
      await this.unchanged(target, made);
      project = await this.register(target, made);
      this.store.add({
        projectId: project.id,
        assistantId: agent.id,
        createdAt: new Date(this.now()).toISOString(),
      });
      recorded = true;
      // Only this freshly registered project is ever granted here, so the call never
      // restores a grant the owner removed.
      granted = true;
      grantCreatedProject(w.access, agent.id, project.id, { coding });
      const result = { projectId: project.id, name: project.name, path: target, coding };
      const row = this.settle(inv, agent, conversation, {
        change: "create",
        projectId: project.id,
        projectName: project.name,
        path: target,
        coding,
        result,
      });
      // Audited once nothing can roll the creation back any more.
      auditAgentProject(w.s, {
        assistantId: agent.id,
        projectId: project.id,
        change: "create",
        coding,
        git,
      });
      notifyAgentProject(w, agent, row);
      this.refresh(agent);
      return result;
    } catch (error) {
      await this.rollback(agent, target, project, { recorded, granted });
      throw error;
    }
  }
  async coding(inv, { agent, conversation }, projectId, enabled) {
    const w = this.w;
    if (!this.store.createdBy(agent.id, projectId))
      throw assistantProblem("projectNotCreatedByYou", 403);
    const { changed } = setCreatedProjectCoding(w.access, agent.id, projectId, enabled);
    const result = { projectId, coding: enabled };
    if (!changed) return result;
    const project = this.project(projectId);
    const row = this.settle(inv, agent, conversation, {
      change: "coding",
      projectId,
      projectName: project?.name ?? null,
      path: project?.cwd ?? null,
      coding: enabled,
      result,
    });
    auditAgentProject(w.s, {
      assistantId: agent.id,
      projectId,
      change: "coding",
      coding: enabled,
    });
    notifyAgentProject(w, agent, row);
    this.refresh(agent);
    return result;
  }
  /**
   * Registers the new folder as a project of its own: never an enclosing repository
   * (the default folder may lie inside one), the home or a collection folder, nor a
   * project AgentPier knew before this call. A project row that already names this
   * path or folder (an earlier project whose folder was deleted, its inode reused) is
   * refused too: registering would rebind it and its data into the new project
   * (ProjectMemory#followGitInit).
   */
  async register(target, made) {
    const memory = this.w.s.memory;
    let project;
    try {
      const scope = await projectScope(target);
      if (scope.cwd !== target) throw Error();
      const folder = JSON.stringify([
        "directory",
        target,
        String(made.dev),
        String(made.ino),
      ]);
      if (memory.claimsFolder(target, [folder, scope.identity])) throw Error();
      const known = new Set(memory.projectNames().map((p) => p.id));
      project = await memory.register(target);
      if (!project || project.cwd !== target || known.has(project.id)) throw Error();
    } catch {
      throw unavailable();
    }
    return project;
  }
  list(agent) {
    const policy = this.w.access.get(agent.id);
    const projects = [];
    for (const { projectId, createdAt } of this.store.list(agent.id)) {
      const project = this.project(projectId);
      if (!project) continue;
      projects.push({
        projectId,
        name: project.name,
        path: project.cwd,
        createdAt,
        folder: policy.projectFiles[projectId] || "none",
        coding:
          policy.projectIds.includes(projectId) &&
          policy.sessionProjectIds.includes(projectId),
      });
    }
    return { projects };
  }
  // The registered project, or null once the owner removed it from AgentPier.
  project(projectId) {
    try {
      return this.w.s.memory.project(projectId);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }
  // Throws unless `target` is still the directory `made` (same device and inode).
  async unchanged(target, made) {
    let now;
    try {
      now = await fs.lstat(target, { bigint: true });
    } catch {
      throw unavailable();
    }
    if (!now.isDirectory() || now.dev !== made.dev || now.ino !== made.ino)
      throw unavailable();
  }
  // The owner's default folder, canonical, an existing and writable directory.
  async parent() {
    try {
      const parent = await fs.realpath(this.w.s.preferences.get().defaultCwd);
      if (!(await fs.stat(parent)).isDirectory()) throw Error();
      await fs.access(parent, constants.W_OK);
      return parent;
    } catch {
      throw unavailable();
    }
  }
  /**
   * The settled row in the agent's chat that tells the owner (actionNotes). It is the
   * point after which the owner notice for the change goes out.
   */
  settle(inv, agent, conversation, payload) {
    const at = this.now();
    return this.w.store.reserve({
      assistantId: agent.id,
      conversationId: conversation.id,
      attemptId: inv.attemptId,
      origin: { kind: "agent-project" },
      key: this.key(inv),
      state: "completed",
      payload: { action: "agent_project", ...payload },
      chatNotes: { result: { at, state: "completed" } },
      settled: true,
    });
  }
  // The new folder and coding guidance reach the agent; a failed apply converges later.
  refresh(agent) {
    const a = this.w.a;
    if (!a.runtime?.client?.ready) return;
    Promise.resolve()
      .then(() => a.admit(() => a.config.apply(agent.id)))
      .catch(() => {});
  }
  async rollback(agent, target, project, { recorded, granted }) {
    try {
      if (granted && this.w.access.revokeProject(project.id).length) this.w.a.changed();
      if (recorded) this.store.remove(project.id, agent.id);
      // Fresh (register refused known and claimed folders), so it holds nothing.
      if (project) this.w.s.memory.removeEmpty(project.id);
    } catch (error) {
      console.error("Agent project rollback failed:", error?.message);
    }
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  }
}
