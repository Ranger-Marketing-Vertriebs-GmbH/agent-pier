// A session's working-tree changes for the Changes tab: the listed workspaces with
// their diff base and counts, and the parsed diff of one of them. A client names a
// workspace only by an id from the list read now; the id is never used as a path.
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { parseGitDiff } from "./diff-parse.js";
import { diffStat, headCommit, workspaceDiff } from "./git-read.js";
import {
  listWorkspaces,
  resolveDefaultBranch,
  workspaceBase,
} from "./session-workspaces.js";

const STAT_CONCURRENCY = 4;

/**
 * @typedef {import("./session-workspaces.js").Base} Base
 * @typedef {{ sha: string, source: "start"|"first-open" }} StartCommit
 * @typedef {{ id: string, branch: string|null, base: Base, files: number,
 *   added: number, removed: number, fingerprint: string }} WorkspaceSummary
 * @typedef {{ repository: boolean, startCommit: StartCommit|null,
 *   workspaces: WorkspaceSummary[], changedFiles: number }} ChangesSummary
 * @typedef {{ workspace: string, base: Base,
 *   files: import("./diff-parse.js").DiffFile[], truncated: boolean }} WorkspaceDiff
 */

const NO_REPOSITORY = Object.freeze({
  repository: false,
  startCommit: null,
  workspaces: [],
  changedFiles: 0,
});

/** Maps `items` through `fn`, at most `limit` at a time, keeping their order. */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const unknownWorkspace = () => problem(serverMessages.changes.unknownWorkspace, 404);

export class SessionChanges {
  constructor({ sessions }) {
    this.sessions = sessions;
  }

  /**
   * The session and its listed workspaces, or null outside a repository. A session
   * without a start commit (started before the field existed) records HEAD now, once;
   * login and pipeline sessions never record one, as at start.
   */
  async context(sessionId) {
    let session = await this.sessions.get(sessionId);
    const listed = await listWorkspaces(session.cwd);
    if (!listed) return null;
    if (!session.startCommit && session.purpose !== "login" && !session.pipeline) {
      const sha = await headCommit(listed.root);
      if (sha) session = await this.sessions.setStartCommit(sessionId, sha, "first-open");
    }
    const startCommit = session.startCommit
      ? { sha: session.startCommit, source: session.startCommitSource ?? "start" }
      : null;
    const defaultBranch = await resolveDefaultBranch(listed.root);
    const base = (workspace) =>
      workspaceBase(workspace, {
        isSessionDir: workspace.id === "",
        defaultBranch,
        startCommit: startCommit?.sha,
      });
    return { workspaces: listed.workspaces, startCommit, base };
  }

  /** @returns {Promise<ChangesSummary>} */
  async summary(sessionId) {
    const context = await this.context(sessionId);
    if (!context) return { ...NO_REPOSITORY, workspaces: [] };
    const rows = await mapLimited(context.workspaces, STAT_CONCURRENCY, async (w) => {
      try {
        const base = await context.base(w);
        const stat = await diffStat(w.path, base.sha);
        return { id: w.id, branch: w.branch, base, ...stat };
      } catch (error) {
        // a worktree removed since the list was read drops out; the session's own fails
        if (w.id === "") throw error;
        return null;
      }
    });
    const workspaces = rows
      .filter(Boolean)
      .sort(
        (a, b) => Number(b.files > 0) - Number(a.files > 0) || (a.id < b.id ? -1 : 1),
      );
    return {
      repository: true,
      startCommit: context.startCommit,
      workspaces,
      changedFiles: workspaces.reduce((sum, w) => sum + w.files, 0),
    };
  }

  /** @returns {Promise<WorkspaceDiff>} */
  async diff(sessionId, workspaceId) {
    const context = await this.context(sessionId);
    const workspace = context?.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) throw unknownWorkspace();
    const base = await context.base(workspace);
    let read;
    try {
      read = await workspaceDiff(workspace.path, base.sha);
    } catch (error) {
      // removed between the list and the read
      if (workspace.id !== "" && !(await listWorkspaces(workspace.path)))
        throw unknownWorkspace();
      throw error;
    }
    return {
      workspace: workspace.id,
      base,
      files: parseGitDiff(read.text),
      truncated: read.truncated,
    };
  }
}
