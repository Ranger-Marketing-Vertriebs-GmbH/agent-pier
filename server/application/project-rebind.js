import fs from "node:fs";
import path from "node:path";
import { gitInitRebind, sameFolder } from "../features/memory/project-rebind.js";

/**
 * Keeps a running session's project when its plain folder became the root of its
 * own Git work tree. The plain-directory project moves to the Git identity: memory
 * entries and session capabilities, SSH keys, hosts and receipts, artifact records,
 * pipeline verification steps, and the SSH project binding of every session launched
 * in that folder. The Git identity must not own memory or SSH access of its own (for
 * example after an older `.git` was restored), so no session ever gains another
 * project's resources. Every step is idempotent, so an interrupted move resumes.
 */
export class ProjectRebind {
  constructor({ dataDir, memory, sshManagement, artifacts, sessions, audit }) {
    Object.assign(this, { dataDir, memory, sshManagement, artifacts, sessions, audit });
    this.queue = Promise.resolve();
    this.incomplete = new Set();
    this.sessionWaitMs = 2000;
    this.definitions = null;
  }
  /** Resolves to the Git project scope, or null when the strict rejection applies. */
  async rebind({ cwd, previousIds }) {
    const found = await gitInitRebind(cwd);
    if (!found) return null;
    return this.serial(() => this.adopt(found, previousIds));
  }
  /**
   * Like rebind, but cheap once a recorded move is complete. Callers whose project
   * is already authorized use it to finish a move another session or an interrupted
   * call left behind.
   */
  async ensure({ cwd, previousIds }) {
    const found = await gitInitRebind(cwd);
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
      Boolean(this.definitions?.hasVerification(fromId))
    );
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
    const current = await gitInitRebind(launch.path);
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
    if (await this.rebindSessions(fromId, scope, launch)) this.incomplete.delete(fromId);
    return scope;
  }
  /**
   * Merges an older project row of a folder into its current project on the owner's
   * explicit request: memory, session capabilities, SSH access, artifacts,
   * verification and the bindings of every session that held the older project move,
   * and the rebind is recorded and audited once. A repeated call finishes an
   * interrupted move. The caller checks that the merge is current and safe.
   */
  mergeDuplicate(fromId, scope) {
    return this.serial(async () => {
      const recorded = this.memory.reboundTo(fromId);
      if (recorded && recorded !== scope.id) return null;
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
        });
      }
      await this.sshManagement.adoptProject(fromId, scope);
      await this.artifacts.moveProject(fromId, scope.id);
      this.definitions?.moveVerification(fromId, scope.id);
      if (await this.rebindSessions(fromId, scope, null)) this.incomplete.delete(fromId);
      return scope;
    });
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
    if (!memory && !ssh) return;
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
  }
}
