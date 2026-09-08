import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateDirectory, readJSON, writePrivate, problem } from "../../lib/storage.js";
import { validId } from "../sessions/session-validation.js";
import { git, exactCommit, resolveBase } from "./workspace-git.js";
import {
  pushWorkspace,
  createWorkspacePr,
  withGitCredentials,
} from "./workspace-forge.js";
import { checkpointWorkspace } from "./workspace-checkpoint.js";
import { NativeEventReader } from "./native-reader.js";

const fenceName = ".agentpier-worktrees";
export class PipelineWorkspace {
  constructor({ dataDir, github, memory, sessions }) {
    this.dataDir = dataDir;
    this.github = github;
    this.memory = memory;
    this.sessions = sessions;
    this.directory = privateDirectory(path.join(dataDir, "pipeline-workspaces"));
  }
  file(runId) {
    return path.join(this.directory, `${validId(runId)}.json`);
  }
  async prepare({ runId, cwd, baseBranch }) {
    validId(runId);
    const projectRoot = await fs.realpath(
      (await git(await fs.realpath(cwd), ["rev-parse", "--show-toplevel"])).trim(),
    );
    const file = this.file(runId),
      existing = readJSON(file, null);
    if (existing) {
      if (existing.projectRoot !== projectRoot)
        throw problem("Workspace ownership does not match.", 409);
      if (existing.preparing) return this.adopt(existing);
      await this.inspect(existing);
      return existing;
    }
    const root = path.join(projectRoot, fenceName),
      workingDir = path.join(root, runId);
    await fs.mkdir(root, { recursive: true });
    const fence = await fs.lstat(root);
    if (
      !fence.isDirectory() ||
      fence.isSymbolicLink() ||
      (await fs.realpath(root)) !== root
    )
      throw problem("The owned worktree directory is unsafe.", 409);
    if (
      await fs.lstat(workingDir).then(
        () => true,
        () => false,
      )
    )
      throw problem("The run worktree already exists.", 409);
    let fetchWarning;
    const origin = await git(projectRoot, ["remote", "get-url", "origin"]).catch(
      () => null,
    );
    if (origin && this.github) {
      try {
        await withGitCredentials(this, { projectRoot }, (env) =>
          git(projectRoot, ["fetch", "origin", "--prune"], { env, timeout: 60000 }),
        );
      } catch {
        fetchWarning =
          "Origin could not be refreshed; the selected local reference was used.";
      }
    }
    const base = await resolveBase(projectRoot, baseBranch),
      branch = `agentpier/${runId}`;
    const source = await fs.stat(projectRoot);
    const sourceBranch =
      baseBranch || (await git(projectRoot, ["branch", "--show-current"])) || "HEAD";
    const workspace = {
      runId,
      cwd: workingDir,
      projectRoot,
      branch,
      baseSha: base.sha,
      baseBranch: sourceBranch,
      ownership: randomUUID(),
      projectDevice: source.dev,
      projectInode: source.ino,
      ...(fetchWarning ? { fetchWarning } : {}),
    };
    writePrivate(file, { ...workspace, preparing: true });
    try {
      await git(
        projectRoot,
        ["worktree", "add", "--no-track", "-b", branch, workingDir, base.sha],
        { timeout: 60000 },
      );
      return await this.finalize(workspace);
    } catch (error) {
      await git(projectRoot, ["worktree", "remove", workingDir], {
        timeout: 60000,
      }).catch(() => {});
      // A failed intent remains inspectable; never delete an ambiguous directory recursively.
      throw error;
    }
  }
  async adopt(intent) {
    const workspace = { ...intent };
    delete workspace.preparing;
    const expected = path.join(workspace.projectRoot, fenceName, workspace.runId);
    if (
      workspace.cwd !== expected ||
      workspace.branch !== `agentpier/${validId(workspace.runId)}` ||
      (await fs.realpath(path.dirname(expected))) !== path.dirname(expected) ||
      (await fs.realpath(expected)) !== expected
    )
      throw problem(
        "The interrupted worktree preparation cannot be safely recovered.",
        409,
      );
    const source = await fs.stat(workspace.projectRoot);
    if (source.dev !== workspace.projectDevice || source.ino !== workspace.projectInode)
      throw problem("The source repository identity changed during preparation.", 409);
    const [branch, head, common, sourceCommon, registered] = await Promise.all([
      git(expected, ["branch", "--show-current"]),
      exactCommit(expected, "HEAD"),
      git(expected, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(workspace.projectRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      git(workspace.projectRoot, ["worktree", "list", "--porcelain"]),
    ]);
    const record = registered
      .split("\n\n")
      .find((value) => value.split("\n").includes(`worktree ${expected}`));
    if (
      branch !== workspace.branch ||
      head !== workspace.baseSha ||
      (await fs.realpath(common)) !== (await fs.realpath(sourceCommon)) ||
      !record?.split("\n").includes(`branch refs/heads/${workspace.branch}`)
    )
      throw problem(
        "The interrupted worktree no longer matches its preparation intent.",
        409,
      );
    return this.finalize(workspace);
  }
  async finalize(workspace) {
    const created = await fs.stat(workspace.cwd);
    Object.assign(workspace, { device: created.dev, inode: created.ino });
    const common = (
      await git(workspace.projectRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim();
    workspace.commonDir = await fs.realpath(common);
    const exclude = path.join(workspace.commonDir, "info/exclude");
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    const excludeInfo = await fs.lstat(exclude).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      excludeInfo &&
      (!excludeInfo.isFile() || excludeInfo.isSymbolicLink() || excludeInfo.nlink !== 1)
    )
      throw problem("The Git exclusion file is unsafe.", 409);
    const previous = await fs.readFile(exclude, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const exclusions = [`/${fenceName}/`, "/.pipeline/"].filter(
      (line) => !previous.split("\n").includes(line),
    );
    if (exclusions.length) await fs.appendFile(exclude, `\n${exclusions.join("\n")}\n`);
    if (this.memory)
      workspace.projectId = (await this.memory.register(workspace.projectRoot)).id;
    writePrivate(this.file(workspace.runId), workspace);
    return workspace;
  }
  async validate(workspace) {
    const stored = readJSON(this.file(workspace?.runId), null);
    if (
      !stored ||
      stored.preparing ||
      stored.removed ||
      ["ownership", "cwd", "projectRoot", "branch", "baseSha"].some(
        (key) => stored[key] !== workspace[key],
      )
    )
      throw problem("Workspace ownership does not match.", 409);
    const root = path.join(stored.projectRoot, fenceName);
    if (
      stored.cwd !== path.join(root, stored.runId) ||
      (await fs.realpath(root)) !== root ||
      (await fs.realpath(stored.cwd)) !== stored.cwd
    )
      throw problem("Workspace ownership path changed.", 409);
    const [project, worktree] = await Promise.all([
      fs.stat(stored.projectRoot),
      fs.lstat(stored.cwd),
    ]);
    if (
      !worktree.isDirectory() ||
      project.dev !== stored.projectDevice ||
      project.ino !== stored.projectInode ||
      worktree.dev !== stored.device ||
      worktree.ino !== stored.inode
    )
      throw problem("Workspace ownership identity changed.", 409);
    const common = await fs.realpath(
      (
        await git(stored.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
      ).trim(),
    );
    if (common !== stored.commonDir)
      throw problem("Workspace Git ownership changed.", 409);
    const branch = await git(stored.cwd, ["branch", "--show-current"]);
    if (branch !== stored.branch)
      throw problem("The run worktree switched to another branch.", 409);
    return stored;
  }
  async inspect(value) {
    const workspace = await this.validate(value.workspace || value);
    const [headSha, status, log] = await Promise.all([
      exactCommit(workspace.cwd, "HEAD"),
      git(workspace.cwd, ["status", "--porcelain", "--untracked-files=normal"]),
      git(workspace.cwd, [
        "log",
        "--format=%H%x09%s",
        "-n",
        "200",
        `${workspace.baseSha}..HEAD`,
      ]),
    ]);
    return {
      branch: workspace.branch,
      headSha,
      dirty: Boolean(status),
      commits: log
        ? log.split("\n").map((line) => {
            const [sha, ...subject] = line.split("\t");
            return { sha, subject: subject.join("\t") };
          })
        : [],
    };
  }
  async diff({ workspace, from, to }) {
    const stored = await this.validate(workspace),
      start = await exactCommit(stored.cwd, from || stored.baseSha),
      end = to ? await exactCommit(stored.cwd, to) : null;
    const result = await git(
      stored.cwd,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        start,
        ...(end ? [end] : []),
        "--",
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return {
      diff: result.slice(0, 1024 * 1024),
      truncated: result.length > 1024 * 1024,
      from: start,
      to: end,
    };
  }
  async push({ workspace }) {
    const stored = await this.validate(workspace);
    return pushWorkspace(this, stored);
  }
  async checkpoint(input) {
    return checkpointWorkspace(this, input);
  }
  async createPr({ workspace, run }) {
    const stored = await this.validate(workspace);
    return createWorkspacePr(this, stored, run);
  }
  async remove({ workspace }) {
    const stored = await this.validate(workspace),
      state = await this.inspect(stored);
    if (this.sessions) {
      const reader = new NativeEventReader(this.dataDir);
      for (const session of await this.sessions.list())
        if (session.pipeline?.runId === stored.runId) {
          if (
            session.status === "running" ||
            !(await reader.receipt(session.id).catch(() => null))?.groupStopped
          )
            throw problem(
              "Wait for the owned native pipeline processes to finish before cleanup.",
              409,
            );
        }
    }
    if (state.dirty)
      throw problem(
        "The worktree has uncommitted changes; preserve or commit them before cleanup.",
        409,
      );
    if (state.commits.length) {
      const unpublished = await git(stored.cwd, [
        "rev-list",
        "--count",
        "HEAD",
        "--not",
        "--remotes=origin",
      ]);
      if (unpublished !== "0")
        throw problem(
          "The worktree has unpublished commits; push them before cleanup.",
          409,
        );
    }
    await git(stored.projectRoot, ["worktree", "remove", stored.cwd], { timeout: 60000 });
    writePrivate(this.file(stored.runId), { ...stored, removed: true });
    return { removed: true };
  }
}
