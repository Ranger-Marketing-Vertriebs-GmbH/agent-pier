import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isShared } from "../users/user-access.js";
import { MAX_SHARE_BYTES } from "./agent-share-source.js";
import { UNCLAIMED, checkedChatFolder } from "./chat-file-folders.js";
import { generatedPrefix } from "./hermes-generated-images.js";

// An AgentPier before per-chat created images copied each image a Hermes agent created
// into `generated-images/` of its work folder, which every chat of an agent shared
// with users reads and searches. After each start's move of attachments/
// (chat-file-migration.js) a shared agent's images leave it: only files named as
// Hermes names a created image (`<prefix>_<YYYYMMDD>_<HHMMSS>_<8 hex>.<ext>`,
// agent/provider_media.py), so a folder of that name the agent or a user made keeps
// everything else. One whose bytes a live shared file of an existing chat holds (the
// share store keeps their size and SHA-256) goes into that chat's folder as
// `generated-<name>`, kept like a newly created image (hermes-generated-images.js) and
// gone with the next quota check once that shared copy is past 90 days, as its
// mtime stays; any other goes to `.unclaimed`, which no chat reads. Each move is one
// rename on one file system, so a run stopped anywhere is finished by the next; an
// entry that cannot move stays, and while one does the guard refuses reads of the
// folder (hermes-tool-guard.js). A user's own agent and the owner's keep the folder:
// all their chats are one person's.

/** The work folder's folder of images an older AgentPier created. */
export const OLD_IMAGES = "generated-images";
const createdName =
  /^[A-Za-z0-9-]{1,40}_\d{8}_\d{6}_[0-9a-f]{8}\.(?:png|jpe?g|webp|gif)$/;

/** Whether `folder` still holds an image the move has to take (true when unsure). */
export function leftoverImages(folder) {
  try {
    return fsSync.readdirSync(folder).some((name) => createdName.test(name));
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

const digest = async (file) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

// The work folder's generated-images/ as a real directory at its real place, or null.
async function oldImages(workspaces, assistantId) {
  if (!workspaces) return null;
  const workspace = path.join(workspaces, assistantId);
  const folder = path.join(workspace, OLD_IMAGES);
  try {
    const [root, own, ownReal, stat, real] = await Promise.all([
      fs.realpath(workspaces),
      fs.lstat(workspace),
      fs.realpath(workspace),
      fs.lstat(folder),
      fs.realpath(folder),
    ]);
    const inPlace =
      own.isDirectory() &&
      ownReal === path.join(root, assistantId) &&
      stat.isDirectory() &&
      real === path.join(ownReal, OLD_IMAGES);
    return inPlace ? folder : null;
  } catch {
    return null;
  }
}

// `size:sha256` of each live file the agent shared → the existing chat it was first
// shared into (a mirror in a lead's chat is no chat of the agent's).
function sharedChats(a, assistantId) {
  const chats = new Map();
  for (const file of a.shared.live(assistantId)) {
    if (typeof file.sha256 !== "string" || typeof file.from === "string") continue;
    if (a.shared.expired(file)) continue;
    const chat = file.row.conversation_id;
    try {
      if (a.store.getConversation(chat).assistantId !== assistantId) continue;
    } catch {
      continue;
    }
    const key = `${file.size}:${file.sha256}`;
    if (!chats.has(key)) chats.set(key, chat);
  }
  return chats;
}

// The chat folder an image goes to, or null for .unclaimed.
async function chatOf(a, assistantId, chats, from) {
  const stat = await fs.lstat(from);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SHARE_BYTES) return null;
  const chat = chats.get(`${stat.size}:${await digest(from)}`);
  return chat ? checkedChatFolder(a.config, [assistantId, chat], true) : null;
}

/**
 * Moves a shared Hermes agent's old images (`a`: AgentAttachments, whose serial queue
 * the caller holds). Never throws: an entry that fails stays for the next start.
 * Resolves with how many moved.
 */
export async function migrateGeneratedImages(a, assistantId) {
  try {
    if (!isShared(a.store.getAssistant(assistantId))) return 0;
  } catch {
    return 0;
  }
  const folder = await oldImages(a.config?.workspaces, assistantId);
  if (!folder) return 0;
  let moved = 0;
  try {
    const chats = sharedChats(a, assistantId);
    for (const name of await fs.readdir(folder)) {
      if (!createdName.test(name)) continue;
      const from = path.join(folder, name);
      try {
        const chat = await chatOf(a, assistantId, chats, from).catch(() => null);
        const to = chat && path.join(chat.path, generatedPrefix + name);
        if (to && !(await fs.lstat(to).catch(() => null))) await fs.rename(from, to);
        else await unclaimed(a, assistantId, from, name);
        moved++;
      } catch (error) {
        console.warn(`Hermes created image not moved: ${error?.key || error?.code}`);
      }
    }
  } catch (error) {
    console.warn(`Hermes created images not moved: ${error?.key || error?.code}`);
  }
  await fs.rmdir(folder).catch(() => {});
  return moved;
}

// Into `.unclaimed`, under a new name when its own is taken.
async function unclaimed(a, assistantId, from, name) {
  const folder = await checkedChatFolder(a.config, [assistantId, UNCLAIMED], true);
  const taken = await fs.lstat(path.join(folder.path, name)).catch(() => null);
  const target = taken ? `${randomUUID().slice(0, 8)}-${name}` : name;
  await fs.rename(from, path.join(folder.path, target));
}
