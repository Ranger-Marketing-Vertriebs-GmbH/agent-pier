import fs from "node:fs";
import path from "node:path";
import { gitInitRebind, sameFolder } from "../features/memory/project-rebind.js";

/**
 * Keeps a running session's project when its plain folder became the root of its
 * own Git work tree. The plain-directory project moves to the Git identity: memory
 * entries and session capabilities, SSH keys, hosts and receipts, artifact records,
 * pipeline verification steps, queue settings and queue items, secrets, and the SSH and
 * secrets project binding of every session launched
 * in that folder. Agent grants and unstarted approvals of the older project are dropped,
 * never moved. The Git identity must not own memory or SSH access of its own (for
 * example after an older `.git` was restored), so no session ever gains another
 * project's resources. Every step is idempotent, so an interrupted move resumes.
 */
export class ProjectRebind {
  constructor({
    dataDir,
    memory,
    sshManagement,
    secrets = null,
    sessionSecrets = null,
    artifacts,
    sessions,
    audit,
    assistantWorkflows = () => null,
  }) {
    Object.assign(this, {
      dataDir,
      memory,
      sshManagement,
      secrets,
      sessionSecrets,
      artifacts,
      sessions,
      audit,
      assistantWorkflows,
    });
    this.queue = Promise.resolve();
    this.incomplete = new Set();
    this.sessionWaitMs = 2000;
    this.definitions = null;
    this.runQueue = null;
  }
  /**
   * `found` (see gitInitRebind) with the plain-folder project of a recorded move.
   * Once that project's row is gone, its directory ID is hashed afresh and differs
   * after the volume was renumbered at boot; a recorded rebind of one of
   * `candidates` to the same Git project names it instead.
   */
  recorded(found, candidates = []) {
    if (!found || this.memory.reboundTo(found.fromId) === found.scope.id) return found;
    const fromId = candidates?.find((id) => this.memory.reboundTo(id) === found.scope.id);
    return fromId ? { ...found, fromId } : found;
  }
  /** Resolves to the Git project scope, or null when the strict rejection applies. */
  async rebind({ cwd, previousIds }) {
    const found = this.recorded(await gitInitRebind(cwd), previousIds);
    if (!found) return null;
    return this.serial(() => this.adopt(found, previousIds));
  }
  /**
   * Like rebind, but cheap once a recorded move is complete. Callers whose project
   * is already authorized use it to finish a move another session or an interrupted
   * call left behind.
   */
  async ensure({ cwd, previousIds }) {
    const found = this.recorded(await gitInitRebind(cwd), previousIds);
    if (!found) return null;
    const { fromId, scope } = found;
    if (this.memory.reboundTo(fromId) === scope.id && !this.remnants(fromId))
      return scope;
    return this.serial(() => this.adopt(found, previousIds));
  }
  serial(operation) {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => {});
    return run;
  }
  remnants(fromId) {
    return (
      this.incomplete.has(fromId) ||
      this.memory.hasProject(fromId) ||
      this.memory.ownsEntries(fromId) ||
      this.sshManagement.knowsProject(fromId) ||
      this.artifacts.ownsProject(fromId) ||
      Boolean(this.definitions?.hasVerification(fromId)) ||
      Boolean(this.runQueue?.ownsProject(fromId)) ||
      this.assistantsHold(fromId)
    );
  }
  // An agent feature that was off (or failed) during the move leaves grants behind;
  // they make the move unfinished, so ensure() and the start-up cleanup rerun it.
  assistantsHold(fromId) {
    try {
      return Boolean(this.assistantWorkflows()?.holdsProject(fromId));
    } catch {
      return false;
    }
  }
  async adopt({ fromId, scope, launch }, previousIds) {
    const recorded = this.memory.reboundTo(fromId);
    if (recorded && recorded !== scope.id) return null;
    if (!recorded) {
      if (!previousIds?.includes(fromId)) return null;
      if (this.memory.ownsEntries(scope.id) || this.sshManagement.ownsProject(scope.id))
        return null;
    }
    // The folder must still be the same one when shared state starts to move.
    const current = this.recorded(await gitInitRebind(launch.path), [fromId]);
    if (current?.fromId !== fromId || current.scope.id !== scope.id) return null;
    this.incomplete.add(fromId);
    this.memory.adopt(fromId, scope);
    // Audited once, when the rebind is recorded; later steps resume on failure.
    if (!recorded)
      this.audit.append({
        action: "project.updated",
        resourceType: "project",
        resourceId: scope.id,
        projectId: scope.id,
        source: "system",
        outcome: "success",
      });
    await this.sshManagement.adoptProject(fromId, scope);
    await this.artifacts.moveProject(fromId, scope.id);
    this.definitions?.moveVerification(fromId, scope.id);
    this.runQueue?.moveProject(fromId, scope.id);
    this.revokeAssistants(fromId, scope.id);
    const rebound = await this.rebindSessions(fromId, scope, launch);
    this.moveSecrets(fromId, scope.id);
    if (rebound) this.incomplete.delete(fromId);
    return scope;
  }
  /**
   * Merges an older project row of a folder into its current project on the owner's
   * explicit request: memory, session capabilities, SSH access, artifacts,
   * verification and the bindings of every session that held the older project move,
   * agent grants of the older project are dropped, and the rebind is recorded and audited once. `check` runs first inside the queue
   * and throws when the merge is stale or unsafe, so concurrent merges and resumes
   * see each other's results. The merge stays pending in memory until every step is
   * done; a repeated call (or the start-up resume) finishes it. A recorded rebind
   * that is no pending merge (for example a finished one, or a `git init` rebind)
   * moves nothing.
   */
  mergeDuplicate(fromId, scope, check = async () => {}) {
    return this.serial(async () => {
      await check();
      const recorded = this.memory.reboundTo(fromId);
      if (recorded && recorded !== scope.id) return null;
      if (recorded && this.memory.pendingMerge(fromId) !== scope.id) return scope;
      this.incomplete.add(fromId);
      if (!recorded) {
        this.memory.merge(fromId, scope);
        this.audit.append({
          action: "project.updated",
          resourceType: "project",
          resourceId: scope.id,
          projectId: scope.id,
          source: "user",
          outcome: "success",
          details: { fromProjectId: fromId },
        });
      }
      await this.sshManagement.adoptProject(fromId, scope);
      await this.artifacts.moveProject(fromId, scope.id);
      this.definitions?.moveVerification(fromId, scope.id);
      this.runQueue?.moveProject(fromId, scope.id);
      this.revokeAssistants(fromId, scope.id);
      const rebound = await this.rebindSessions(fromId, scope, null);
      this.moveSecrets(fromId, scope.id);
      if (rebound) {
        this.incomplete.delete(fromId);
        this.memory.finishMerge(fromId);
      }
      return scope;
    });
  }
  /**
   * After the session bindings, so the secrets files rewritten on the change already
   * see the sessions in the new project.
   */
  moveSecrets(fromId, toId) {
    this.secrets?.moveProject(fromId, toId);
  }
  /**
   * Agent grants do not follow a project to its new row; the older id leaves them, so
   * no save names a missing project. Skipped while the agent feature is off: a later
   * resume (remnants) finishes it, and a save drops the stale id (assistant-access.js).
   */
  revokeAssistants(fromId, toId) {
    this.assistantWorkflows()?.revokeProject(fromId, toId);
  }
  /** Returns false when a busy session was skipped; a later call retries it. */
  async rebindSessions(fromId, scope, launch) {
    const directory = path.join(this.dataDir, "sessions");
    let names = [];
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let complete = true;
    for (const name of names) {
      const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.json$/.exec(name);
      if (!match) continue;
      const update = this.sessions.serial(
        () => this.rebindSession(match[1], fromId, scope, launch),
        match[1],
      );
      let timer;
      const waited = await Promise.race([
        update.then(
          () => true,
          () => false,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), this.sessionWaitMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      if (!waited) complete = false;
    }
    return complete;
  }
  async rebindSession(id, fromId, scope, launch) {
    let session;
    try {
      session = await this.sessions.metadata(id);
    } catch {
      return;
    }
    const binding = session.sshTools?.project;
    const memory = session.memory?.projectId === fromId;
    // Without a launch folder (an owner-requested merge) every binding moves.
    const ssh =
      binding?.projectId === fromId && (!launch || sameFolder(binding.launch, launch));
    // The secrets binding follows the SSH one it was taken from (session-secrets.js).
    const secrets = session.secrets?.projectId === fromId && (ssh || !binding);
    if (!memory && !ssh && !secrets) return;
    if (secrets) session.secrets.projectId = scope.id;
    if (ssh) {
      const { id: projectId, name, cwd, kind, identity } = scope;
      session.sshTools.project = {
        projectId,
        name,
        cwd,
        kind,
        identity,
        launch: binding.launch,
      };
    }
    if (memory) session.memory.projectId = scope.id;
    await this.sessions.save(session);
    // A session rebound on a retry sees no secret change: its file catches up here.
    if (secrets) this.sessionSecrets?.refresh().catch(() => {});
  }
}
