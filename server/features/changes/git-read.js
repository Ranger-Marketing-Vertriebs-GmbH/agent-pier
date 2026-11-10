import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { safeGitArgs } from "../../lib/git-command.js";
import { git, gitEnvironment } from "../pipelines/workspace-git.js";
import { remoteDefaultBranch } from "../tickets/ticket-worktree.js";

export const DIFF_BYTE_LIMIT = 1048576;
export const UNTRACKED_LIMIT = 200;
const COUNT_FILE_LIMIT = 256 * 1024;
const NUMSTAT_LIMIT = 8 * 1024 * 1024;
// Changed paths whose size and mtime go into a workspace's fingerprint.
const FINGERPRINT_PATH_LIMIT = 2000;
export const DIFF_FLAGS = [
  "-c",
  "core.quotePath=false",
  "diff",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
];

function failure() {
  return problem(serverMessages.pipelineWorkspaces.gitOperationFailed, 409);
}

/**
 * Runs git and reads at most `limit` bytes of stdout; a longer output is cut at its
 * last complete `boundary` byte (a line by default) and flagged. Another exit code
 * than `okCodes` and a timeout reject with the git failure problem.
 */
export function readBounded(
  cwd,
  args,
  { limit = DIFF_BYTE_LIMIT, timeout = 30000, okCodes = [0], boundary = 10 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", safeGitArgs(args), {
      cwd,
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let size = 0,
      truncated = false,
      settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, failure());
    }, timeout);
    child.on("error", () => finish(reject, failure()));
    child.stdout.on("data", (chunk) => {
      if (truncated) return;
      if (size + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - size));
        size = limit;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.on("close", (code) => {
      if (!truncated && !okCodes.includes(code)) return finish(reject, failure());
      let buffer = Buffer.concat(chunks);
      if (truncated) buffer = buffer.subarray(0, buffer.lastIndexOf(boundary) + 1);
      finish(resolve, { text: buffer.toString("utf8"), truncated });
    });
  });
}

/**
 * HEAD commit of the repository at `cwd`, or null outside one / without commits or
 * when git takes longer than `timeout` ms.
 */
export async function headCommit(cwd, { timeout = 30000 } = {}) {
  try {
    return (
      (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
        timeout,
      })) || null
    );
  } catch {
    return null;
  }
}

/** Untracked, not ignored files (at most `UNTRACKED_LIMIT`); `more` when cut. */
export async function untrackedFiles(cwd) {
  const { text } = await readBounded(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { boundary: 0 },
  );
  const all = text.split("\0").filter((entry) => entry && !entry.endsWith("/"));
  return { paths: all.slice(0, UNTRACKED_LIMIT), more: all.length > UNTRACKED_LIMIT };
}

function untrackedDiff(cwd, file, limit) {
  return readBounded(cwd, [...DIFF_FLAGS, "--no-index", "--", "/dev/null", file], {
    limit,
    okCodes: [0, 1],
  });
}

/** Tracked changes against `base` plus each untracked file while room is left. */
export async function workspaceDiff(cwd, base, { limit = DIFF_BYTE_LIMIT } = {}) {
  const tracked = await readBounded(cwd, [...DIFF_FLAGS, "--find-renames", base, "--"], {
    limit,
  });
  if (tracked.truncated) return tracked;
  const listed = await untrackedFiles(cwd);
  let text = tracked.text,
    truncated = listed.more;
  for (const file of listed.paths) {
    const room = limit - Buffer.byteLength(text);
    if (room <= 0) return { text, truncated: true };
    const part = await untrackedDiff(cwd, file, room);
    text += part.text;
    if (part.truncated) return { text, truncated: true };
  }
  return { text, truncated };
}

async function untrackedLines(cwd, file) {
  try {
    const target = path.join(cwd, file);
    const info = await fs.lstat(target);
    if (!info.isFile() || info.size > COUNT_FILE_LIMIT) return 0;
    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) return 0;
    let lines = 0;
    for (const byte of buffer) if (byte === 10) lines += 1;
    return buffer.length && buffer[buffer.length - 1] !== 10 ? lines + 1 : lines;
  } catch {
    return 0;
  }
}

/**
 * A short hash over the numstat output and the size and mtime of each changed path,
 * so an edit that keeps the counts still reads as a change.
 */
async function fingerprint(cwd, numstat, paths) {
  const hash = createHash("sha256").update(numstat);
  const sampled = paths.slice(0, FINGERPRINT_PATH_LIMIT);
  const stats = await Promise.all(
    sampled.map((file) =>
      fs.lstat(path.join(cwd, file)).then(
        (info) => `${info.size}:${info.mtimeMs}`,
        () => "-",
      ),
    ),
  );
  sampled.forEach((file, index) => hash.update(`\0${file}\0${stats[index]}`));
  return hash.digest("hex").slice(0, 16);
}

/**
 * Changed files and +/- lines against `base`, untracked files included, and a
 * `fingerprint` that changes with any edit of a changed file.
 */
export async function diffStat(cwd, base) {
  const { text, truncated } = await readBounded(
    cwd,
    [...DIFF_FLAGS, "--numstat", "-z", "--find-renames", base, "--"],
    { limit: NUMSTAT_LIMIT, boundary: 0 },
  );
  const tokens = text.split("\0");
  // the last token of a cut output may be partial
  if (truncated || tokens[tokens.length - 1] === "") tokens.pop();
  const stat = { files: 0, added: 0, removed: 0 };
  const paths = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!match) continue;
    stat.files += 1;
    stat.added += Number(match[1]) || 0;
    stat.removed += Number(match[2]) || 0;
    if (match[3] !== "") paths.push(match[3]);
    else {
      // a rename lists its old and new path next
      if (tokens[i + 2] !== undefined) paths.push(tokens[i + 2]);
      i += 2;
    }
  }
  const listed = await untrackedFiles(cwd);
  for (const file of listed.paths) {
    stat.files += 1;
    stat.added += await untrackedLines(cwd, file);
    paths.push(file);
  }
  return { ...stat, fingerprint: await fingerprint(cwd, text, paths) };
}

/** Remote default branch, else a local `main`/`master`, else null. */
export async function defaultBranch(cwd) {
  try {
    return await remoteDefaultBranch(cwd);
  } catch {
    for (const name of ["main", "master"]) {
      const found = await git(cwd, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${name}^{commit}`,
      ]).catch(() => "");
      if (found) return name;
    }
    return null;
  }
}
