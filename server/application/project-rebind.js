import fs from "node:fs";
import path from "node:path";
import { gitInitRebind, sameFolder } from "../features/memory/project-rebind.js";

/**
 * Keeps a running session's project when its plain folder became the root of its
 * own Git work tree. The plain-directory project moves to the Git identity: memory
 * entries and session capabilities, SSH keys, hosts and receipts, artifact records,
 * and the SSH project binding of every session launched in that folder. The Git
 * identity must not own memory or SSH access of its own (for example after an older
 * `.git` was restored), so no session ever gains another project's resources.
 */
export class ProjectRebind {
  constructor({ dataDir, memory, sshManagement, artifacts, sessions, audit }) {
    Object.assign(this, { dataDir, memory, sshManagement, artifacts, sessions, audit });
    this.queue = Promise.resolve();
  }
  /** Resolves to the Git project scope, or null when the strict rejection applies. */
  async rebind({ cwd, previousIds }) {
    const found = await gitInitRebind(cwd);
    if (!found) return null;
    const run = this.queue.then(() => this.adopt(found, previousIds));
    this.queue = run.catch(() => {});
    return run;
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
    this.memory.adopt(fromId, scope);
    await this.sshManagement.adoptProject(fromId, scope);
    await this.artifacts.moveProject(fromId, scope.id);
    await this.rebindSessions(fromId, scope, launch);
    if (!recorded)
      this.audit.append({
        action: "project.updated",
        resourceType: "project",
        resourceId: scope.id,
        projectId: scope.id,
        source: "system",
        outcome: "success",
      });
    return scope;
  }
  async rebindSessions(fromId, scope, launch) {
    const directory = path.join(this.dataDir, "sessions");
    let names = [];
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const name of names) {
      const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.json$/.exec(name);
      if (!match) continue;
      await this.sessions.serial(async () => {
        let session;
        try {
          session = await this.sessions.metadata(match[1]);
        } catch {
          return;
        }
        const binding = session.sshTools?.project;
        const memory = session.memory?.projectId === fromId;
        const ssh = binding?.projectId === fromId && sameFolder(binding.launch, launch);
        if (!memory && !ssh) return;
        if (ssh) {
          const { id, name: projectName, cwd, kind, identity } = scope;
          session.sshTools.project = {
            projectId: id,
            name: projectName,
            cwd,
            kind,
            identity,
            launch: binding.launch,
          };
        }
        if (memory) session.memory.projectId = scope.id;
        await this.sessions.save(session);
      }, match[1]);
    }
  }
}
