import {
  assertUnchanged,
  createProjectFolder,
  initRepository,
} from "../projects/project-folder.js";
import { exact } from "./assistant-access.js";
import { auditAgentProject } from "./assistant-access-audit.js";
import { assistantProblem } from "./assistant-validation.js";
import { AgentProjectStore } from "./agent-project-store.js";
import { grantCreatedProject, setCreatedProjectCoding } from "./agent-project-grants.js";
import { projectName } from "./agent-project-rules.js";
import { loopGuard } from "./agent-loop-guard.js";
import { ownerChatCall } from "./owner-runs.js";
import { notifyAgentProject } from "./agent-project-notes.js";
import { mayCreateProjects } from "./goal-turns.js";
import { runtimeAccepts } from "./runtimes/runtime-for.js";

const optionalBoolean = (value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw assistantProblem("invalid");
  return value;
};

export { initRepository };

/**
 * Any run of the owner's chat with an agent that may create projects (owner-runs.js
 * ownerChatCall, AGENTPIER-276), never a routine's or a hook's run, forwarded or
 * member content; throws otherwise. Shaped like agent-ssh-proposals.js proposalTurn.
 */
export function projectTurn(w, inv) {
  const turn = ownerChatCall(w.a, inv);
  if (!turn) throw assistantProblem("invalid", 403);
  const { agent, conversation, origin } = turn;
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
    loopGuard(w.a.store).take(agent.id);
    // The shared safe creation (project-folder.js) fails clean; from here on a failure
    // also removes what this call recorded for the folder: the grant, the creation
    // record and the registration (the project is fresh, so it holds nothing yet).
    const folder = await createProjectFolder({
      preferences: w.s.preferences,
      memory: w.s.memory,
      name,
      git,
      label: "Agent project",
      gitInit: (target) => this.gitInit(target),
      unchanged: (target, made) => this.unchanged(target, made),
    });
    const { project, path: target } = folder;
    let recorded = false,
      granted = false;
    try {
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
      await this.rollback(agent, folder, project, { recorded, granted });
      throw error;
    } finally {
      await folder.release();
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
  unchanged(target, made) {
    return assertUnchanged(target, made);
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
    // Its own runtime: OpenClaw's Gateway, or a Hermes agent's set.
    if (!runtimeAccepts(a.runtime, agent)) return;
    Promise.resolve()
      .then(() => a.admit(() => a.config.apply(agent.id)))
      .catch(() => {});
  }
  async rollback(agent, folder, project, { recorded, granted }) {
    try {
      if (granted && this.w.access.revokeProject(project.id).length) this.w.a.changed();
      if (recorded) this.store.remove(project.id, agent.id);
    } catch (error) {
      console.error("Agent project rollback failed:", error?.message);
    }
    // The registration and the folder this call made.
    await folder.rollback();
  }
}
