import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { waitsForAgents } from "./deletion-errors.js";
import { inside } from "./deletion-paths.js";

function refusal() {
  return Object.assign(problem(serverMessages.projectDeletion.projectDeleting, 409), {
    code: "PROJECT_DELETING",
  });
}

const unreadable = () =>
  Object.assign(problem(serverMessages.projectDeletion.deletionsUnreadable, 503), {
    code: "PROJECT_DELETIONS_UNREADABLE",
  });

function realOrResolved(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Refuses every start path for a folder whose deletion is recorded. `records` is read
 * on each call, so a closed or not yet open memory covers nothing; records an open
 * memory cannot read refuse everything (503) rather than let work start unchecked. A
 * deletion that only waits for the agents covers its project ids, not its folder.
 */
export class DeletionGuard {
  constructor(records) {
    this.records = records;
  }
  #list() {
    const records = this.records();
    if (!records) return [];
    try {
      return records.list();
    } catch (error) {
      if (records.db?.isOpen === false) return [];
      throw Object.assign(unreadable(), { cause: error });
    }
  }
  covers(cwd) {
    if (typeof cwd !== "string" || !cwd) return false;
    const list = this.#list().filter((record) => !waitsForAgents(record));
    if (!list.length) return false;
    const candidates = new Set([path.resolve(cwd), realOrResolved(cwd)]);
    return list.some((record) =>
      [...candidates].some((candidate) => inside(record.path, candidate)),
    );
  }
  coversProject(projectId) {
    return this.#list().some((record) => record.body.projectIds?.includes(projectId));
  }
  refuse(cwd) {
    if (this.covers(cwd)) throw refusal();
  }
  refuseProject(projectId) {
    if (this.coversProject(projectId)) throw refusal();
  }
}
