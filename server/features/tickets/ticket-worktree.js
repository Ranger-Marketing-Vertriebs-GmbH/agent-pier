import fs from "node:fs/promises";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { git, gitRef, resolveBase } from "../pipelines/workspace-git.js";
import { withGitCredentials } from "../pipelines/workspace-forge.js";

const fenceName = ".worktrees";
const TITLE_SLUG_LIMIT = 30;

function slug(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
function keySlug(ticket) {
  return slug(String(ticket?.key ?? "").replace(/^#/, "")).slice(0, 40) || "ticket";
}
function idSlug(value) {
  return slug(value).slice(0, 8) || "x";
}

/** Branch `ticket/<key>-<title>`; ticket text is untrusted, so only [a-z0-9-] survives. */
export function ticketBranchName(ticket, taken = new Set()) {
  const title = slug(ticket?.title).slice(0, TITLE_SLUG_LIMIT).replace(/-+$/, "");
  const base = `ticket/${keySlug(ticket)}${title ? `-${title}` : ""}`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

export class TicketWorktrees {
  constructor({ dataDir, github }) {
    this.dataDir = dataDir;
    this.github = github;
  }

  async #root(projectPath) {
    return fs.realpath(
      (
        await git(await fs.realpath(projectPath), ["rev-parse", "--show-toplevel"])
      ).trim(),
    );
  }

  async #fence(projectRoot, name) {
    const root = path.join(projectRoot, fenceName),
      cwd = path.join(root, name);
    const entry = await fs.lstat(root).catch(() => null);
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory()))
      throw problem(serverMessages.pipelineWorkspaces.worktreeDirectoryUnsafe, 409);
    await this.#exclude(projectRoot);
    await fs.mkdir(root, { recursive: true });
    const fence = await fs.lstat(root);
    if (
      !fence.isDirectory() ||
      fence.isSymbolicLink() ||
      (await fs.realpath(root)) !== root
    )
      throw problem(serverMessages.pipelineWorkspaces.worktreeDirectoryUnsafe, 409);
    if (await this.exists(cwd, true))
      throw problem(serverMessages.pipelineWorkspaces.worktreeExists, 409);
    return cwd;
  }

  /** Keeps `.worktrees/` out of `git status` without touching the repo's `.gitignore`. */
  async #exclude(projectRoot) {
    const ignored = await git(projectRoot, ["check-ignore", "-q", ".worktrees/x"]).then(
      () => true,
      () => false,
    );
    if (ignored) return;
    const common = await git(projectRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const file = path.join(common.trim(), "info", "exclude");
    const current = await fs.readFile(file, "utf8").catch(() => "");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `${current}${current && !current.endsWith("\n") ? "\n" : ""}/.worktrees/\n`,
    );
  }

  /** Refreshes origin; `fetched` is false when there is no origin or no credentials. */
  async #fetch(projectRoot, args) {
    const origin = await git(projectRoot, ["remote", "get-url", "origin"]).catch(
      () => null,
    );
    if (!origin || !this.github) return { fetched: false };
    try {
      await withGitCredentials(this, { projectRoot }, (env) =>
        git(projectRoot, ["fetch", "origin", ...args], { env, timeout: 60000 }),
      );
      return { fetched: true };
    } catch {
      return { fetched: false, fetchWarning: "originRefreshFailed" };
    }
  }

  async #hasRemoteRef(projectRoot, name) {
    return git(projectRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${name}^{commit}`,
    ]).then(
      () => true,
      () => false,
    );
  }

  /** Remote default branch only: `origin/HEAD`, then `main`, then `master`. */
  async #defaultBranch(projectRoot) {
    const head = await git(projectRoot, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]).catch(() => "");
    if (
      head.startsWith("origin/") &&
      (await this.#hasRemoteRef(projectRoot, head.slice(7)))
    )
      return head.slice(7);
    for (const name of ["main", "master"])
      if (await this.#hasRemoteRef(projectRoot, name)) return name;
    throw problem(serverMessages.pipelineWorkspaces.originBaseUnavailable, 409);
  }

  async #base(projectRoot, baseBranch) {
    const name = baseBranch ? gitRef(baseBranch) : await this.#defaultBranch(projectRoot);
    if (!(await this.#hasRemoteRef(projectRoot, name)))
      throw problem(serverMessages.pipelineWorkspaces.originBaseUnavailable, 409);
    return resolveBase(projectRoot, name);
  }

  async #takenBranches(projectRoot) {
    const listed = await git(projectRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes/origin",
    ]);
    return new Set(
      listed
        .split("\n")
        .map((ref) =>
          ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, ""),
        )
        .filter(Boolean),
    );
  }

  async #add(projectRoot, cwd, branch, sha, { reset = false } = {}) {
    try {
      await git(
        projectRoot,
        ["worktree", "add", "--no-track", reset ? "-B" : "-b", branch, cwd, sha],
        { timeout: 60000 },
      );
    } catch (error) {
      await git(projectRoot, ["worktree", "remove", cwd], { timeout: 60000 }).catch(
        () => {},
      );
      throw error;
    }
  }

  async createSession({ projectPath, ticket, baseBranch, name }) {
    const projectRoot = await this.#root(projectPath);
    const cwd = await this.#fence(projectRoot, safeName(name));
    const { fetchWarning } = await this.#fetch(projectRoot, ["--prune"]);
    const base = await this.#base(projectRoot, baseBranch);
    const branch = ticketBranchName(ticket, await this.#takenBranches(projectRoot));
    await this.#add(projectRoot, cwd, branch, base.sha);
    return {
      cwd,
      projectRoot,
      branch,
      baseRef: base.ref,
      baseSha: base.sha,
      ...(fetchWarning ? { fetchWarning } : {}),
    };
  }

  /** `suffix` (e.g. the failing head) tells several repairs of one item apart. */
  async createRepair({ projectPath, headRef, name, suffix = "" }) {
    gitRef(headRef);
    const projectRoot = await this.#root(projectPath);
    const cwd = await this.#fence(projectRoot, safeName(name));
    const refreshed = await this.#fetch(projectRoot, [
      "--prune",
      `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`,
    ]);
    // A repair never starts from a ref that was not just fetched.
    if (!refreshed.fetched)
      throw problem(serverMessages.pipelineWorkspaces.originRefreshFailed, 409);
    const base = await resolveBase(projectRoot, `refs/remotes/origin/${headRef}`);
    const tail = slug(suffix).slice(0, 12);
    const branch = `ticket-repair/${idSlug(name.split("-").pop())}${tail ? `-${tail}` : ""}`;
    // A leftover branch whose worktree is gone must not block the repair.
    await git(projectRoot, ["worktree", "prune"]);
    await this.#add(projectRoot, cwd, branch, base.sha, { reset: true });
    return { cwd, projectRoot, branch, headRef };
  }

  async exists(cwd, anyEntry = false) {
    try {
      const entry = await fs.lstat(cwd);
      return anyEntry || entry.isDirectory();
    } catch {
      return false;
    }
  }
}

function safeName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name))
    throw problem(serverMessages.pipelineWorkspaces.worktreeDirectoryUnsafe, 409);
  return name;
}
