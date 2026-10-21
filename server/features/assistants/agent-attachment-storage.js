import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { SHARED } from "./agent-share-store.js";

// Per agent; counted over the copies still present in its workspace. Room for a few
// phone videos (200 MB each, agent-video-types.js) next to photos and documents.
export const MAX_AGENT_BYTES = 1024 * 1024 * 1024;
export const MAX_AGENT_FILES = 1000;
// Entries a usage count reads at most: a folder flooded by the agent costs no more.
const MAX_SCAN = 5000;
const FOLDER = "attachments";
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
 * Removes a checked entry (`{ path, dev, ino }` from a check; `directory: false` for
 * a link, file or other non-directory in a folder's place) without following a link
 * or a folder swapped in since the check. The entry is first renamed into `trash`, a
 * private directory outside every agent workspace: rename moves the name itself,
 * never a link's target. A directory is removed only while it still is the checked
 * one (same device and inode); a non-directory is unlinked, which never touches what
 * it points to. Anything else that had taken the place is put back untouched.
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
  // A checked non-directory is only ever unlinked: a directory in its place is put
  // back, even with the same inode number (Linux reuses a freed one at once).
  if (folder.directory === false) {
    if (moved && !moved.isDirectory()) {
      await fs.unlink(aside);
      return true;
    }
    await fs.rename(aside, folder.path).catch(() => {});
    throw unsafe();
  }
  if (!moved?.isDirectory() || moved.dev !== folder.dev || moved.ino !== folder.ino) {
    await fs.rename(aside, folder.path).catch(() => {});
    throw unsafe();
  }
  await fs.rm(aside, { recursive: true, force: true });
  return true;
}

// The owner's folders a crash left in the trash before their removal finished. A
// link there is removed itself, never followed.
async function sweepTrash(trash, prefix) {
  for (const name of await fs.readdir(trash))
    if (name.startsWith(prefix))
      await fs.rm(path.join(trash, name), { recursive: true, force: true });
}

/** The private trash beside a storage root: `<assistants>/attachment-trash`. */
export function trashFor(root) {
  return path.join(path.dirname(root), "attachment-trash");
}

/**
 * The owner's view of an agent's attachments folder and clearing it
 * (agent-attachments.js). An agent that put a link, a file or anything else that is
 * not a directory in the folder's place blocks every upload; clearing removes that
 * entry itself, and the next upload makes the folder again.
 */
export class AttachmentStorage {
  constructor(attachments) {
    this.a = attachments;
  }
  /**
   * `{ folder }` for the checked folder (null when there is none), or `{ replaced }`
   * when the agent's own real workspace holds a non-directory in the folder's place.
   * Any other unsafe storage stays refused.
   */
  async locate(assistantId) {
    let refused = null;
    const folder = await this.a.folder(assistantId, false).catch((error) => {
      refused = error;
      return null;
    });
    if (folder) return { folder };
    const replaced = await this.replaced(assistantId);
    if (replaced) return { replaced };
    if (refused) throw refused;
    return { folder: null };
  }
  async replaced(assistantId) {
    const root = this.a.config?.workspaces;
    if (!root) return null;
    const workspace = path.join(root, assistantId);
    try {
      const [realRoot, own, real] = await Promise.all([
        fs.realpath(root),
        fs.lstat(workspace),
        fs.realpath(workspace),
      ]);
      if (!own.isDirectory() || real !== path.join(realRoot, assistantId)) return null;
      const entry = path.join(workspace, FOLDER);
      const stat = await fs.lstat(entry, { bigint: true });
      if (stat.isDirectory()) return null;
      return { path: entry, dev: stat.dev, ino: stat.ino, directory: false };
    } catch {
      return null;
    }
  }
  /** What the folder holds against its limits; `unsafe` when it was replaced. */
  async usage(assistantId) {
    this.a.store.getAssistant(assistantId);
    const { folder, replaced } = await this.locate(assistantId);
    const limits = { maxBytes: MAX_AGENT_BYTES, maxFiles: MAX_AGENT_FILES };
    if (replaced) return { files: 0, bytes: 0, capped: false, unsafe: true, ...limits };
    return { ...(await folderUsage(folder)), ...limits };
  }
  /**
   * Empties the folder (the quota's folder only; files the agent shared live in the
   * share store and stay), or removes what replaced it. Uploads still arriving end
   * first, with their partial copies; unsent files lose their rows, and sent ones
   * stay in their messages marked unavailable. Resolves with what was removed.
   */
  async clear(assistantId) {
    const a = this.a;
    a.store.getAssistant(assistantId);
    return a.serial(assistantId, async () => {
      const removed = await this.removeFolder(assistantId);
      a.transaction(() => {
        a.db
          .prepare(
            "DELETE FROM agent_attachments WHERE assistant_id=? AND request_id IS NULL",
          )
          .run(assistantId);
        for (const file of a.rows(
          `SELECT * FROM agent_attachments WHERE assistant_id=? AND request_id IS NOT NULL AND request_id NOT LIKE '${SHARED}%'`,
          assistantId,
        ))
          if (!file.gone) a.markGone(file);
      });
      return { files: removed.files, bytes: removed.bytes };
    });
  }
  /**
   * Removes the uploads of every chat `keep(conversationId)` refuses from the folder,
   * for a shared agent that became one user's own: on it no turn checks the chat a
   * file came from any more (attachment-access.js). Unsent files lose their rows, sent
   * ones stay in their messages marked unavailable; shared files live elsewhere.
   */
  async removeChats(assistantId, keep) {
    const a = this.a;
    return a.serial(assistantId, async () => {
      const folder = await a.folder(assistantId, false).catch(() => null);
      for (const file of a.rows(
        `SELECT * FROM agent_attachments WHERE assistant_id=? AND (request_id IS NULL OR request_id NOT LIKE '${SHARED}%')`,
        assistantId,
      )) {
        if (keep(file.row.conversation_id)) continue;
        if (folder) await fs.rm(path.join(folder.path, file.file), { force: true });
        if (file.row.request_id === null)
          a.db.prepare("DELETE FROM agent_attachments WHERE id=?").run(file.id);
        else if (!file.gone) a.markGone(file);
      }
    });
  }
  // Ends the agent's open uploads and removes its checked folder, or what replaced
  // it; the caller holds the agent's serial queue. Resolves with what it held.
  async removeFolder(assistantId) {
    await this.a.videos.dropAgent(assistantId);
    const { folder, replaced } = await this.locate(assistantId);
    const held = await folderUsage(folder);
    const target = folder || replaced;
    if (!target) return held;
    await this.a.hooks.clearing?.(target);
    const trash = trashFor(this.a.config.workspaces);
    await removeChecked(target, trash, `${assistantId}-attachments`);
    return held;
  }
  // Removes an agent's copies (both folders only as checked) and their index, for
  // when the agent itself goes. Unwired: nothing deletes agents yet.
  purge(assistantId) {
    return this.a.serial(assistantId, async () => {
      await this.removeFolder(assistantId);
      await this.a.shared.purge(assistantId);
      this.a.db
        .prepare("DELETE FROM agent_attachments WHERE assistant_id=?")
        .run(assistantId);
    });
  }
}
