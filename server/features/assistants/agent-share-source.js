import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { assistantProblem } from "./assistant-validation.js";
import { openInside } from "./project-open.js";

// What an agent may hand the owner with agentpier_share_file. Telegram takes photos
// up to 10 MB and documents up to 50 MB; the chat route serves what the store holds.
export const MAX_SHARE_BYTES = 25 * 1024 * 1024;
export const MAX_CAPTION_LENGTH = 1024;
const MAX_PATH_LENGTH = 4096;

/**
 * The folders an agent may share files from: its own workspace, or the real root of
 * a granted project folder (agent-shares.js projectSource); every root is checked the
 * same way.
 */
export function shareRoots(workspaces, assistant, projects = []) {
  const own =
    workspaces && typeof assistant?.id === "string"
      ? [path.join(workspaces, assistant.id)]
      : [];
  return [...own, ...projects];
}

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
    ? relative
    : null;
};

const notFound = (error) =>
  ["ENOENT", "ENOTDIR"].includes(error?.code)
    ? assistantProblem("shareNotFound", 404)
    : assistantProblem("shareOutside", 403);

// Every directory from the root down to the file's folder is a real directory
// (never a link): the refusal names why before the open.
async function walk(root, parts) {
  let current = root;
  for (const part of [null, ...parts]) {
    if (part !== null) current = path.join(current, part);
    const stat = await fs.lstat(current, { bigint: true }).catch((error) => {
      throw notFound(error);
    });
    if (stat.isSymbolicLink()) throw assistantProblem("shareOutside", 403);
    if (!stat.isDirectory()) throw assistantProblem("shareNotFound", 404);
  }
}
/**
 * Reads the file an agent shares: a regular file inside one of `roots`, named by a
 * path relative to the first root or absolute inside one. No component may be a
 * symbolic link and the file may have no second hard link, so nothing outside the
 * roots is reachable through the workspace. The bytes are read through the checked
 * descriptor, within MAX_SHARE_BYTES. Returns `{ name, body }`.
 *
 * A folder that an agent with a shell swaps for a link after these checks is
 * refused by the open itself (openInside: no link in any component on macOS, the
 * descriptor's own path on Linux).
 */
export async function readShareSource(
  roots,
  requested,
  // `admit(relative)` may refuse the file by its path below its root.
  { maxBytes = MAX_SHARE_BYTES, admit = () => {} } = {},
) {
  if (
    typeof requested !== "string" ||
    !requested.trim() ||
    requested.length > MAX_PATH_LENGTH ||
    /[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/u.test(requested)
  )
    throw assistantProblem("invalid");
  const candidates = [];
  // A relative path names a file in the first root, the agent's own workspace.
  for (const root of path.isAbsolute(requested) ? roots : roots.slice(0, 1)) {
    const real = await fs.realpath(root).catch(() => null);
    // A root that is itself a link (a workspace swapped for one) shares nothing.
    const parent = await fs.realpath(path.dirname(root)).catch(() => null);
    if (!real || real !== path.join(parent, path.basename(root))) continue;
    const target = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(root, requested);
    // An absolute path may name the root as configured or as resolved.
    const relative = inside(root, target) ?? inside(real, target);
    if (relative !== null) candidates.push({ real, expected: path.join(real, relative) });
  }
  if (!candidates.length) throw assistantProblem("shareOutside", 403);
  const { real: realRoot, expected } = candidates[0];
  admit(inside(realRoot, expected));
  const parts = inside(realRoot, expected).split(path.sep);
  // A link anywhere on the way (even one back into the workspace) is refused.
  await walk(realRoot, parts.slice(0, -1));
  const leaf = await fs.lstat(expected).catch((error) => {
    throw notFound(error);
  });
  if (leaf.isSymbolicLink()) throw assistantProblem("shareOutside", 403);
  if (leaf.isDirectory()) throw assistantProblem("shareNotFound", 404);
  let handle;
  try {
    handle = await openInside(expected, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw notFound(error);
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (stat.isDirectory()) throw assistantProblem("shareNotFound", 404);
    if (!stat.isFile() || stat.nlink !== 1n) throw assistantProblem("shareOutside", 403);
    if (stat.size > BigInt(maxBytes)) throw assistantProblem("shareTooLarge", 413);
    if (stat.size === 0n) throw assistantProblem("shareEmpty", 400);
    const size = Number(stat.size);
    const body = Buffer.alloc(size + 1);
    let read = 0;
    while (read < body.length) {
      const { bytesRead } = await handle.read(body, read, body.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    // A file still being written is not shared half-way.
    if (read !== size) throw assistantProblem("conflict", 409);
    return { name: path.basename(expected), body: body.subarray(0, size) };
  } finally {
    await handle.close();
  }
}
