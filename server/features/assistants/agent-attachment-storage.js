import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";

// Entries a usage count reads at most: a folder flooded by the agent costs no more.
const MAX_SCAN = 5000;
const unsafe = () => assistantProblem("attachmentStorageUnsafe", 409);
const ignoreExisting = (error) => {
  if (error.code !== "EEXIST") throw error;
};

/** Entries and regular-file bytes in a checked folder, read without following links. */
export async function folderUsage(folder) {
  let files = 0;
  let bytes = 0;
  let capped = false;
  if (!folder) return { files, bytes, capped };
  for await (const entry of await fs.opendir(folder.path)) {
    if (files >= MAX_SCAN) {
      capped = true;
      break;
    }
    files++;
    if (!entry.isFile()) continue;
    bytes +=
      (await fs.lstat(path.join(folder.path, entry.name)).catch(() => null))?.size || 0;
  }
  return { files, bytes, capped };
}

/**
 * Removes a checked folder (`{ path, dev, ino }` from a folder check) and everything
 * in it, without following a link or a folder swapped in since the check. The entry
 * is first renamed into `trash`, a private directory outside every agent workspace:
 * rename moves the name itself, never a link's target. Only when the moved entry is
 * still the checked directory (same device and inode) is it removed, out of the
 * agent's reach; anything else that had taken its place is put back untouched.
 * `owner` (an agent id and the store, never a dot inside) names its trash entries.
 */
export async function removeChecked(folder, trash, owner) {
  let aside;
  try {
    await fs.mkdir(trash, { mode: 0o700 }).catch(ignoreExisting);
    const own = await fs.lstat(trash);
    if (!own.isDirectory()) throw Error("unsafe");
    await sweepTrash(trash, `${owner}.`);
    aside = path.join(trash, `${owner}.${randomUUID()}`);
    await fs.rename(folder.path, aside);
  } catch (error) {
    if (error.code === "ENOENT" && aside) return false;
    throw unsafe();
  }
  const moved = await fs.lstat(aside, { bigint: true }).catch(() => null);
  if (!moved?.isDirectory() || moved.dev !== folder.dev || moved.ino !== folder.ino) {
    await fs.rename(aside, folder.path).catch(() => {});
    throw unsafe();
  }
  await fs.rm(aside, { recursive: true, force: true });
  return true;
}

// The owner's folders a crash left in the trash before their removal finished.
async function sweepTrash(trash, prefix) {
  for (const name of await fs.readdir(trash))
    if (name.startsWith(prefix))
      await fs.rm(path.join(trash, name), { recursive: true, force: true });
}

/** The private trash beside a storage root: `<assistants>/attachment-trash`. */
export function trashFor(root) {
  return path.join(path.dirname(root), "attachment-trash");
}
