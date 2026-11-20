import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectDir } from "../lib/config.js";
import { serverMessages } from "../lib/i18n/de.js";
import { problem } from "../lib/storage.js";
import { auditActor } from "../features/audit/audit-actor.js";
import {
  AGENTS_OFF,
  replaceableDeletion,
  waitsForAgents,
} from "../features/projects/deletion-errors.js";
import { inside } from "../features/projects/deletion-paths.js";
import { endProcess } from "../features/projects/folder-processes.js";
import { normalizeProjectPath } from "../features/projects/project-groups.js";
import { projectDataLeft, removeProjectData } from "./project-data-removal.js";
import {
  deletionBlockers,
  preflight,
  preflightProbes,
  refusalMessage,
} from "./project-deletion-preflight.js";
import {
  deletionScope,
  deletionToken,
  folderIdentity,
  folderKey,
} from "./project-deletion-scope.js";

const messages = serverMessages.projectDeletion;
export { AGENTS_OFF };
// What a deletion that waits for the agents (AGENTS_OFF) still has to remove.
const agentData = ["agentGrants", "agentSessions"];

const refusal = (message, status, code, extra = {}) =>
  Object.assign(problem(message, status), { code, ...extra });
const deleting = () => refusal(messages.projectDeleting, 409, "PROJECT_DELETING");
const stale = () => refusal(messages.deleteStale, 409, "PROJECT_DELETE_STALE");
const blocked = () => refusal(messages.deleteBlocked, 409, "PROJECT_DELETE_BLOCKED");
// After the mark the agents' grants are revoked; an abort does not restore them.
const abortedBlocked = () =>
  refusal(messages.abortedBlocked, 409, "PROJECT_DELETE_BLOCKED", {
    grantsRevoked: true,
  });
function aborted(error) {
  if (error?.code === "PROJECT_DELETE_STALE")
    return refusal(messages.abortedStale, 409, error.code, { grantsRevoked: true });
  if (error?.code === "PROJECT_DELETE_BLOCKED") return abortedBlocked();
  return refusal(messages.aborted, error?.status || 500, "PROJECT_DELETE_ABORTED", {
    grantsRevoked: true,
  });
}
// One that cannot be stopped stays listed in the report that follows.
const attempt = (work) => work().catch((error) => log("stop", error));
const coded = (code) => Object.assign(new Error(code), { code });
// The re-check after marking reads no Git: unsaved work only warns.
const skipGit = async () => ({
  status: "none",
  worktrees: [],
  unpushedBranches: null,
  worktreesChecked: true,
});

/**
 * The key a deletion of `rawPath` is recorded and queued under: the path with the
 * links of its parent folders resolved (`/tmp/app` and `/private/tmp/app` on macOS
 * meet), the folder itself as written, so a link there is refused, not followed.
 */
export function deletionKey(rawPath) {
  const normal = normalizeProjectPath(rawPath);
  if (!path.isAbsolute(normal) || path.resolve(normal) !== normal || normal === "/")
    return normal;
  return path.join(folderKey(path.dirname(normal)), path.basename(normal));
}

const anyBlocker = (blockers) => Object.values(blockers).some((list) => list.length > 0);

const unsaved = (git) =>
  git.some(
    ({ report }) =>
      report?.unpushedBranches > 0 ||
      (report?.worktrees ?? []).some((tree) => tree.changes > 0 || tree.unpushed > 0),
  );

/**
 * Deletes a project folder and everything AgentPier keeps about it, after a
 * preflight (project-deletion-preflight.js) whose token the owner presents. The
 * deletion is recorded in memory (memory.deletions) before anything is removed, so
 * DeletionGuard refuses new work in the folder and a deletion that stopped midway
 * finishes at the next start. Order: mark, revoke agent grants, re-check, delete the
 * folder, remove the data, audit, drop the record. A step that fails leaves the
 * record "failed" with its error code; retry continues from where it stopped.
 */
export class ProjectDeletion {
  constructor(
    services,
    {
      probes = {},
      removeData = removeProjectData,
      dataLeft = projectDataLeft,
      end = endProcess,
    } = {},
  ) {
    this.services = services;
    this.probes = { ...preflightProbes, ...probes };
    this.removeData = removeData;
    this.dataLeft = dataLeft;
    this.end = end;
    this.queue = new Map();
    // Sessions and processes the owner ended, per folder, for the audit record.
    this.ended = new Map();
    // Agents switched on again: a deletion that waited for them finishes.
    services.assistantFeature?.events?.on?.("started", () => void this.resume());
  }

  get records() {
    return this.services.memory.deletions;
  }

  /** The report the delete dialog shows; see preflight(). */
  preflight(rawPath) {
    return preflight(this.services, deletionKey(rawPath), this.probes);
  }

  /**
   * Stops what blocks a deletion, as the owner asked: with `sessions`, every running
   * session of the scope and every other session with a process in the folder, its
   * unfinished runs, waiting queue items and running Craft rebuilds; each ticked process that a fresh scan still finds, endable and with the
   * same start time. Returns the new report. Nothing is deleted.
   */
  endBlockers({ path: rawPath, token, sessions = false, processes = [] }, _principal) {
    const key = deletionKey(rawPath);
    return this.#serial(key, async () => {
      this.#refuseRecorded(key);
      const before = await preflight(this.services, key, {
        ...this.probes,
        git: skipGit,
      });
      if (before.token !== token) throw stale();
      if (before.refused) throw this.#refused(before.refused);
      const ended = this.#endedOf(before.path);
      if (sessions) await this.#stopWork(before.blockers, ended);
      const ticked = new Map(processes.map((item) => [item.pid, item.startTime]));
      for (const item of before.processes.list) {
        // Only a process whose start time was ticked and still matches is ended.
        const tickedStart = ticked.get(item.pid);
        if (!tickedStart || tickedStart !== item.startTime) continue;
        if (!item.endable) continue;
        const result = await this.end(item);
        if (result === "ended" || result === "gone")
          ended.processes.set(item.pid, { pid: item.pid, name: item.name });
      }
      return this.preflight(key);
    });
  }

  /**
   * Marks the folder as being deleted once the token, the name (for a present
   * folder) and the checks hold, revokes the agents' grants and checks again; the
   * deletion itself continues in the background (settled()).
   */
  start({ path: rawPath, token, name }, principal) {
    const key = deletionKey(rawPath);
    return this.#serial(key, async () => {
      this.#refuseRecorded(key);
      const scope = await deletionScope(this.services, key);
      if (deletionToken(scope) !== token) throw this.#staleOrReappeared(scope, token);
      const report = await this.preflight(key);
      if (report.token !== token) throw stale();
      if (report.refused) throw this.#refused(report.refused);
      if (report.folderState === "present" && name !== report.name)
        throw refusal(messages.deleteName, 400, "PROJECT_DELETE_NAME");
      if (!report.ready) throw blocked();
      // A failed record this start replaces: the ids it names go with this deletion,
      // and an abort writes it back.
      const previous = this.records.get(scope.path);
      const { projectIds } = this.records.mark(
        scope.path,
        this.#body(scope, report, previous?.body),
      ).body;
      // A deletion of a folder around or inside this one, started meanwhile: no await
      // lies between a mark and this check, so of two such starts one gives way.
      if (this.#recordedAround(scope.path)) {
        this.#undo(scope.path, previous);
        throw deleting();
      }
      this.#changed();
      try {
        for (const id of projectIds)
          this.services.assistantWorkflows?.revokeProject(id, id);
        // New work is refused from the mark on; what started before it shows now.
        const after = await preflight(this.services, key, {
          ...this.probes,
          git: skipGit,
        });
        const fresh = await deletionScope(this.services, key);
        const unchanged = after.token === token && deletionToken(fresh) === token;
        if (!unchanged) throw stale();
        if (after.refused || !after.ready) throw blocked();
        this.records.mark(scope.path, this.#body(fresh, report, previous?.body));
      } catch (error) {
        // Nothing was deleted: the folder is no longer being deleted.
        this.#undo(scope.path, previous);
        this.#changed();
        throw aborted(error);
      }
      this.#background(scope.path, principal);
      return { state: "deleting" };
    });
  }

  /** Continues a failed deletion once nothing runs in it. */
  retry(rawPath, principal) {
    const key = deletionKey(rawPath);
    return this.#serial(key, async () => {
      const record = this.records.get(key);
      if (record?.state !== "failed")
        throw refusal(messages.notFailed, 409, "PROJECT_DELETE_NOT_FAILED");
      this.records.again(key);
      this.#changed();
      if (await this.#stillBlocked(key, record.body)) {
        this.records.fail(key, "PROJECT_DELETE_BLOCKED");
        this.#changed();
        throw abortedBlocked();
      }
      this.#background(key, principal);
      return { state: "deleting" };
    });
  }

  /**
   * Finishes, in the background, the deletions an earlier start left marked and those
   * that waited for the agents while they run; one in which something runs again
   * fails instead. Failed deletions wait for retry. A folder with queued work (a
   * deletion just started) is left to it. Never throws.
   */
  async resume() {
    let records;
    try {
      records = this.records.list();
    } catch {
      return;
    }
    for (const record of records) {
      const waited = waitsForAgents(record);
      if (record.state !== "deleting" && !(waited && this.services.assistantWorkflows))
        continue;
      if (this.queue.has(record.path)) continue;
      void this.#serial(record.path, async () => {
        const current = this.records.get(record.path);
        if (!current || (current.state !== "deleting" && current.error !== AGENTS_OFF))
          return;
        if (await this.#stillBlocked(record.path, current.body)) {
          this.records.fail(record.path, "PROJECT_DELETE_BLOCKED");
          this.#changed();
          return;
        }
        if (current.state === "failed") this.records.again(record.path);
        await this.#run(record.path, null);
      }).catch((error) => log("finish", error));
    }
  }

  /** Waits for the running work of a folder (tests). */
  async settled(rawPath) {
    const key = deletionKey(rawPath);
    let tail;
    while ((tail = this.queue.get(key))) await tail;
  }

  async #run(key, principal) {
    const record = this.records.get(key);
    if (record?.state !== "deleting") return;
    let { body } = record;
    try {
      if (body.dataRemoved) {
        // Only the agents' grants were left: whatever is at the path now is not this
        // deletion's; nothing there and no path-keyed data is touched.
        await this.removeData(this.services, body, key, principal, { agentsOnly: true });
      } else {
        if (body.folderMissing || body.folderRemoved) {
          // Never deleted again: a folder there now is another one.
          if (await exists(key)) throw coded("PROJECT_FOLDER_REAPPEARED");
        } else {
          await this.#removeFolder(key, body);
          body = this.records.update(key, { ...body, folderRemoved: true }).body;
        }
        await this.removeData(this.services, body, key, principal);
      }
      const left = this.dataLeft(this.services, body, key).filter(
        (name) => !body.dataRemoved || agentData.includes(name),
      );
      if (left.length) {
        if (
          !this.services.assistantWorkflows &&
          left.every((name) => name === "agentGrants")
        ) {
          this.records.update(key, { ...body, dataRemoved: true });
          throw coded(AGENTS_OFF);
        }
        throw coded("PROJECT_DATA_LEFT");
      }
      this.#audit(key, body, principal);
      this.records.drop(key);
      this.ended.delete(key);
      this.services.live?.invalidate("agentbus.changed");
      // The folder's group assignment went with the data.
      this.services.live?.invalidate("project-groups.changed");
    } catch (error) {
      log("delete", error);
      this.records.fail(key, error?.code || "PROJECT_DELETE_FAILED");
    } finally {
      this.#changed();
    }
  }

  // Deletes the folder unless it is gone already; only the folder the token named.
  async #removeFolder(key, body) {
    let now;
    try {
      now = await fs.promises.lstat(key, { bigint: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) return;
      throw error;
    }
    // Checked again right before the removal, mounts inside the folder included.
    const refused = await this.probes.refusedFolder(key, {
      home: this.services.config.home ?? os.homedir(),
      dataDir: this.services.config.dataDir,
      installDir: projectDir,
    });
    if (refused) throw coded("PROJECT_DELETE_REFUSED");
    const found = folderIdentity(now);
    const same =
      now.isDirectory() &&
      found.dev === String(body.dev) &&
      found.ino === String(body.ino) &&
      // A reused inode number: the creation time tells the folders apart.
      (!body.birth || !found.birth || found.birth === body.birth);
    if (!same) throw coded("PROJECT_FOLDER_CHANGED");
    await fs.promises.rm(key, { recursive: true, force: false, maxRetries: 2 });
  }

  // Running work, and for a folder that still exists any process using it; a scan
  // that does not finish counts as a process.
  async #stillBlocked(key, body) {
    if (anyBlocker(await this.#blockers(body))) return true;
    // A folder this deletion removed already is not scanned: one there now is another.
    if (body.folderMissing || body.folderRemoved || body.dataRemoved) return false;
    // A folder that cannot be read is scanned as if it were there.
    if (!(await exists(key).catch(() => true))) return false;
    const scan = await this.probes
      .scan([key])
      .catch(() => ({ status: "failed", processes: [] }));
    return scan.status !== "ok" || scan.processes.length > 0;
  }

  #body(scope, report, carried = null) {
    const main = scope.projects.find((item) => item.main);
    const nested = scope.projects.filter((item) => !item.main);
    const mainIds = main?.memoryIds ?? [];
    const ended = this.#endedOf(scope.path);
    const projectIds = [
      ...mainIds,
      ...scope.projectIds.filter((id) => !mainIds.includes(id)),
    ];
    return {
      name: scope.name,
      folderMissing: scope.folderState === "missing",
      dev: scope.dev,
      ino: scope.ino,
      birth: scope.birth ?? "",
      // The main project's newest row first: the audit names it. Then those of a
      // replaced record, whose grants and data may still be left.
      projectIds: union(projectIds, carried?.projectIds),
      repositoryIds: scope.repositoryIds,
      busIds: scope.busIds,
      sessionIds: union(scope.sessionIds, carried?.sessionIds),
      runIds: scope.runIds,
      rebuildIds: scope.rebuildIds,
      nested: nested.map(({ path, name }) => ({ path, name })),
      report: {
        unsavedGitWork: unsaved(report.git),
        nestedProjectIds: nested.flatMap((item) => item.memoryIds),
        endedSessionIds: [...ended.sessionIds],
        endedProcesses: [...ended.processes.values()],
      },
    };
  }

  #audit(key, body, principal) {
    const id = body.projectIds[0];
    try {
      this.services.audit?.append({
        action: "project.deleted",
        resourceType: "project",
        ...(id ? { resourceId: id, projectId: id } : {}),
        source: "user",
        outcome: "success",
        ...auditActor(principal),
        details: {
          path: key,
          nestedProjectIds: body.report?.nestedProjectIds ?? [],
          endedSessionIds: body.report?.endedSessionIds ?? [],
          endedProcesses: body.report?.endedProcesses ?? [],
          unsavedGitWork: Boolean(body.report?.unsavedGitWork),
          folderMissing: Boolean(body.folderMissing),
        },
      });
    } catch (error) {
      log("audit", error);
    }
  }

  #blockers(body) {
    return deletionBlockers(this.services, {
      sessionIds: body.sessionIds,
      runIds: body.runIds,
      projectIds: body.projectIds,
      rebuildIds: body.rebuildIds,
    });
  }

  async #stopWork(blockers, ended) {
    const { pipelines, pipelineQueue, craftRebuilds } = this.services;
    for (const session of blockers.sessions)
      await attempt(async () => {
        await this.#stopSession(session.id);
        ended.sessionIds.add(session.id);
      });
    for (const run of blockers.runs) await attempt(async () => pipelines.cancel(run.id));
    for (const item of blockers.queue)
      await attempt(async () => pipelineQueue.remove(item.projectId, item.id));
    for (const rebuild of blockers.rebuilds)
      await attempt(async () => craftRebuilds.pause(rebuild.id));
  }

  #stopSession(id) {
    const { reload, sessions } = this.services;
    return reload ? reload.stop(id) : sessions.stop(id);
  }

  #endedOf(key) {
    if (!this.ended.has(key))
      this.ended.set(key, { sessionIds: new Set(), processes: new Map() });
    return this.ended.get(key);
  }

  // A folder whose deletion, or that of a folder around or inside it, is recorded.
  #refuseRecorded(key) {
    // A failed deletion that a retry cannot finish (a missing folder that came back,
    // a folder replaced or refused): a new start deletes the folder there now and
    // takes over the ids the record names. One that waits for the agents never
    // refuses (nests) and is taken over the same way.
    const replaceable = (record) => record.path === key && replaceableDeletion(record);
    const recorded = this.records
      .list()
      .some((record) => !replaceable(record) && nests(record, key));
    if (recorded) throw deleting();
  }

  // Another folder's deletion recorded around or inside `key`.
  #recordedAround(key) {
    return this.records
      .list()
      .some((record) => record.path !== key && nests(record, key));
  }

  // Takes back a mark: the record it replaced as it was, else none.
  #undo(key, previous) {
    if (previous) this.records.restore(previous);
    else this.records.drop(key);
  }

  #refused(code) {
    return refusal(refusalMessage(code), 409, "PROJECT_DELETE_REFUSED", { reason: code });
  }

  // A token of the missing folder, presented while the folder exists again.
  #staleOrReappeared(scope, token) {
    const asMissing = deletionToken({
      ...scope,
      folderState: "missing",
      dev: "",
      ino: "",
      birth: "",
    });
    return scope.folderState !== "missing" && asMissing === token
      ? refusal(messages.folderReappeared, 409, "PROJECT_FOLDER_REAPPEARED")
      : stale();
  }

  #background(key, principal) {
    void this.#serial(key, () => this.#run(key, principal)).catch((error) =>
      log("delete", error),
    );
  }

  #changed() {
    this.services.live?.invalidate("projects.changed");
  }

  // One operation per folder at a time; the background deletion queues behind start.
  #serial(key, work) {
    const next = (this.queue.get(key) ?? Promise.resolve()).then(work);
    const tail = next.then(
      () => {},
      () => {},
    );
    this.queue.set(key, tail);
    tail.then(() => {
      if (this.queue.get(key) === tail) this.queue.delete(key);
    });
    return next;
  }
}

// Whether a deletion recorded at a folder around or inside `key` stands for it; one
// that waits for the agents no longer does.
const nests = (record, key) =>
  !waitsForAgents(record) && (inside(record.path, key) || inside(key, record.path));

const union = (ids, more) => [...new Set([...ids, ...(more ?? [])])];

async function exists(target) {
  try {
    await fs.promises.lstat(target);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false;
    throw error;
  }
}

// Codes only: messages of file system errors name paths.
function log(step, error) {
  console.error(
    `AgentPier could not ${step} a project deletion: ${error?.code || "unknown error"}`,
  );
}
