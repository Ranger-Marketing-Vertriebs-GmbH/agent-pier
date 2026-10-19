import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { git, exactCommit } from "./workspace-git.js";

export const CHANGE_LIMIT = 5000;
const FILE_LIMIT = 1024 * 1024;

// Only AgentPier's own run area stays out of the risk diff; every other path, also a
// private one such as .env or a key file an agent committed itself, is checked.
const runtimePath = (file) => /^\.(?:pipeline|agentpier-worktrees)\//i.test(file);

/**
 * The files a run changed between two commits, from `git diff --raw`: each with its
 * status letter (A, C, D, M, R, T) and path; a rename or copy also names the path it
 * came from, and a submodule pointer names the commit it points to (`submodule`). A
 * rename out of or into the run area keeps its other side as an added or deleted file.
 */
export async function changedPaths(manager, { workspace, from, to }) {
  const stored = await manager.validate(workspace),
    start = await exactCommit(stored.cwd, from || stored.baseSha),
    end = await exactCommit(stored.cwd, to || "HEAD");
  const output = await git(
    stored.cwd,
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--raw",
      "--no-abbrev",
      "--find-renames",
      "-z",
      start,
      end,
      "--",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return { from: start, to: end, changes: parseRawDiff(output) };
}

/** Parses `git diff --raw -z` output into the changes the risk gate checks. */
export function parseRawDiff(output) {
  const fields = output.split("\0");
  const changes = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const [oldMode, newMode, oldSha, newSha, code] = fields[i]
      .replace(/^:/, "")
      .split(" ");
    const status = code[0];
    const paired = status === "R" || status === "C";
    const change = paired
      ? { status, from: fields[i + 1], path: fields[i + 2] }
      : { status, path: fields[i + 1] };
    if ([oldMode, newMode].includes("160000"))
      change.submodule = newMode === "160000" ? newSha : oldSha;
    i += paired ? 3 : 2;
    if (change.from && runtimePath(change.from)) {
      if (!runtimePath(change.path))
        changes.push({ ...change, status: "A", from: undefined });
    } else if (runtimePath(change.path)) {
      if (change.from)
        changes.push({ ...change, status: "D", path: change.from, from: undefined });
    } else changes.push(change);
  }
  const clean = changes.map((change) =>
    Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)),
  );
  if (clean.length > CHANGE_LIMIT)
    throw problem(serverMessages.pipelines.riskTooManyChanges, 409);
  return clean;
}

/**
 * A file's text at a commit, or null when it does not exist there. A file too large to
 * read, or no regular file, throws: the caller cannot tell what it declares.
 */
export async function fileAt(manager, { workspace, sha, path }) {
  const stored = await manager.validate(workspace),
    commit = await exactCommit(stored.cwd, sha);
  if (
    typeof path !== "string" ||
    !path ||
    /[\x00-\x1f\x7f\\]/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw problem(serverMessages.pipelines.invalidArtifactPath);
  const listed = await git(stored.cwd, [
    "--literal-pathspecs",
    "ls-tree",
    "-l",
    "-z",
    commit,
    "--",
    path,
  ]);
  if (!listed) return null;
  const entry = /^\d+ blob [0-9a-f]+\s+(\d+)\t/.exec(listed);
  if (!entry || Number(entry[1]) > FILE_LIMIT) throw Error("Manifest not readable.");
  return git(stored.cwd, ["cat-file", "blob", `${commit}:${path}`], {
    maxBuffer: FILE_LIMIT + 1024,
  });
}
