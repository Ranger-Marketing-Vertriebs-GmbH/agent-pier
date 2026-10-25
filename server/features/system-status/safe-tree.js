import fsp from "node:fs/promises";
import path from "node:path";
import { inFolder } from "../assistants/project-open.js";

/*
 * Measuring and deleting below the data directory without following a link. Every
 * look at an entry and every unlink or rmdir happens in its parent folder as opened
 * (inFolder, project-open.js), so a folder swapped for a link during the cleanup can
 * never redirect a deletion outside the folder it started in. Paths must be real
 * paths (fs.realpath), which hold no link themselves.
 */
const escaped = () =>
  Object.assign(new Error("Path left the folder."), { code: "ELOOP" });
export const allocated = (stat) =>
  Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;

/** The lstat of `name` in `folder` as opened, or null when it does not exist. */
export async function entryStat(folder, name) {
  try {
    return await inFolder(folder, async (at) => fsp.lstat(await at(name)));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Entry names of a folder, read as opened; an absent folder has none. */
export async function folderNames(folder) {
  try {
    return await inFolder(folder, async (at) => fsp.readdir(await at()));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * Allocated bytes, entries and the newest modification time of a tree, links counted
 * as themselves and never followed. `budget.entries` is shared between calls; once
 * it is spent the result is `partial`.
 */
export async function measureTree(folder, budget = { entries: 1_000_000 }) {
  const result = { bytes: 0, entries: 0, newestMs: 0, partial: false };
  const root = await fsp.lstat(folder).catch(() => null);
  if (!root) return result;
  result.bytes += allocated(root);
  result.newestMs = root.mtimeMs;
  if (!root.isDirectory()) return result;
  const stack = [folder];
  while (stack.length) {
    const current = stack.pop();
    let names;
    try {
      names = await fsp.readdir(current);
    } catch {
      continue; // A folder removed or unreadable meanwhile contributes nothing.
    }
    for (const name of names) {
      if (--budget.entries < 0) {
        result.partial = true;
        return result;
      }
      const stat = await fsp.lstat(path.join(current, name)).catch(() => null);
      if (!stat) continue;
      result.entries++;
      result.bytes += allocated(stat);
      if (stat.mtimeMs > result.newestMs) result.newestMs = stat.mtimeMs;
      if (stat.isDirectory()) stack.push(path.join(current, name));
    }
  }
  return result;
}

// Empties `parent/name` (a folder) and removes it; nested folders first.
async function removeFolder(parent, name) {
  const folder = path.join(parent, name);
  const folders = [];
  await inFolder(folder, async (at) => {
    for (const child of await fsp.readdir(await at())) {
      const stat = await fsp.lstat(await at(child));
      if (stat.isDirectory()) folders.push(child);
      else await fsp.unlink(await at(child));
    }
  });
  for (const child of folders) await removeFolder(folder, child);
  await inFolder(parent, async (at) => {
    const stat = await fsp.lstat(await at(name));
    if (!stat.isDirectory()) throw escaped();
    await fsp.rmdir(await at(name));
  });
}

/**
 * Deletes `name` in `parent`: a file or a link is unlinked (a link's target is never
 * touched), a folder is emptied and removed. `expect(stat)` may refuse the entry as
 * it is found now; the deletion then does nothing and returns false.
 */
export async function removeEntry(parent, name, expect = () => true) {
  if (!name || name.includes("/") || name === "." || name === "..") throw escaped();
  const stat = await entryStat(parent, name);
  if (!stat || !expect(stat)) return false;
  if (stat.isDirectory()) await removeFolder(parent, name);
  else
    await inFolder(parent, async (at) => {
      const now = await fsp.lstat(await at(name));
      if (now.ino !== stat.ino || now.dev !== stat.dev) throw escaped();
      await fsp.unlink(await at(name));
    });
  return true;
}
