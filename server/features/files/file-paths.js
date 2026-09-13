import fs from "node:fs/promises";
import { realpath } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileProblem, fileSystemProblem } from "./file-errors.js";

// Native realpath preserves the OS semantics of nested links containing "..".
const canonicalPath = promisify(realpath.native);
const parentSnapshots = new WeakMap();
const revisionFields = ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"];

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function entryRevision(stat, linkIdentity = null) {
  const fields = revisionFields.map((key) => stat[key].toString(10));
  return `e1:${createHash("sha256")
    .update(JSON.stringify([fields, linkIdentity]))
    .digest("hex")}`;
}

export function validateFileName(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    /\p{Cc}/u.test(name) ||
    Buffer.byteLength(name, "utf8") > 255
  )
    throw fileProblem("FILE_INVALID_NAME", 400);
  return name;
}

function checkScope(scope, absolute) {
  if (scope.kind === "project" && !isWithin(scope.root, absolute))
    throw fileProblem("FILE_OUTSIDE_SCOPE", 403);
}

function inputPath(scope, input) {
  if (typeof input !== "string" || input.includes("\0"))
    throw fileProblem("FILE_INVALID_PATH", 400);
  if (scope.kind === "project") {
    if (
      path.isAbsolute(input) ||
      input.split("/").includes("..") ||
      input === "~" ||
      input.startsWith("~/")
    )
      throw fileProblem("FILE_OUTSIDE_SCOPE", 403);
    return input
      .split("/")
      .filter((part) => part && part !== ".")
      .join("/");
  }
  if (input === "" || input === "~") input = scope.home;
  else if (input.startsWith("~/")) input = `${scope.home}/${input.slice(2)}`;
  if (!path.isAbsolute(input)) throw fileProblem("FILE_INVALID_PATH", 400);
  return `/${input
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/")}`;
}

function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

/** Resolve a selected path without discarding its link spelling.
 * stat is internal BigIntStats (or null for a missing leaf), never a JSON payload.
 * parent is the canonical absolute parent of the selected entry, not its link target.
 */
export async function resolveFile(
  scope,
  input,
  { followLeaf = true, allowMissingLeaf = false } = {},
) {
  try {
    const trailingDirectory =
      typeof input === "string" &&
      (input === "." || input.endsWith("/") || input.endsWith("/."));
    const selectedPath = inputPath(scope, input);
    const parts = selectedPath.split("/").filter(Boolean);
    let absolute = scope.kind === "project" ? scope.root : "/";
    if (scope.kind === "project" && (await canonicalPath(absolute)) !== scope.root)
      throw fileProblem("FILE_OUTSIDE_SCOPE", 403);
    let stat = await fs.stat(absolute, { bigint: true });
    let parent = absolute;
    let parentStat = stat;
    let name = "";
    const links = [];
    for (let index = 0; index < parts.length; index++) {
      if (!stat?.isDirectory()) throw fileProblem("FILE_NOT_DIRECTORY", 400);
      name = parts[index];
      parent = absolute;
      parentStat = stat;
      absolute = path.join(parent, name);
      checkScope(scope, absolute);
      const leaf = index === parts.length - 1;
      try {
        stat = await fs.lstat(absolute, { bigint: true });
      } catch (error) {
        if (error.code !== "ENOENT" || !leaf || !allowMissingLeaf) throw error;
        validateFileName(name);
        stat = null;
        break;
      }
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(absolute);
        links.push([absolute, entryRevision(stat), target]);
        if (!leaf || followLeaf || trailingDirectory) {
          absolute = await canonicalPath(absolute);
          checkScope(scope, absolute);
          stat = await fs.stat(absolute, { bigint: true });
          links.push([absolute]);
        }
      }
    }
    if (trailingDirectory && !stat?.isDirectory())
      throw fileProblem("FILE_NOT_DIRECTORY", 400);
    const result = {
      path: selectedPath,
      absolute,
      parent,
      name,
      stat,
      linkIdentity: links.length
        ? createHash("sha256").update(JSON.stringify(links)).digest("hex")
        : null,
    };
    parentSnapshots.set(result, {
      scopeId: scope.id,
      input,
      followLeaf,
      allowMissingLeaf,
      parent,
      identity: identity(parentStat),
    });
    return result;
  } catch (error) {
    throw fileSystemProblem(error);
  }
}

export function assertFileMutationTarget(scope, resolved) {
  if (scope.readOnly) throw fileProblem("FILE_READ_ONLY", 403);
  checkScope(scope, resolved.absolute);
  if (
    resolved.absolute === scope.root ||
    resolved.absolute === path.parse(resolved.absolute).root
  )
    throw fileProblem("FILE_PROTECTED_PATH", 403);
}

// A final native publication must still bind directory handles atomically; this
// snapshot check detects changes since selection, not races after this check.
export async function revalidateFileParent(scope, resolved) {
  const before = parentSnapshots.get(resolved);
  if (!before || before.scopeId !== scope.id) throw fileProblem("FILE_PATH_CHANGED", 409);
  try {
    const fresh = await resolveFile(scope, before.input, {
      followLeaf: before.followLeaf,
      allowMissingLeaf: before.allowMissingLeaf,
    });
    const after = parentSnapshots.get(fresh);
    if (before.parent !== after.parent || before.identity !== after.identity)
      throw fileProblem("FILE_PATH_CHANGED", 409);
  } catch {
    throw fileProblem("FILE_PATH_CHANGED", 409);
  }
}
