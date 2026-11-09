import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isShared } from "../users/user-access.js";
import { MAX_SHARE_BYTES } from "./agent-share-source.js";
import { checkedChatFolder } from "./chat-file-folders.js";
import { generatedPrefix } from "./hermes-generated-images.js";

// An AgentPier before per-chat created images copied each image a Hermes agent created
// into `generated-images/` of its work folder, which every chat of an agent shared
// with users reads and searches. Before each start of a shared agent's process set
// (chat-file-migration.js) they leave it: an image whose bytes a chat's shared file
// holds (the share store keeps their size and SHA-256) goes into that chat's folder
// as `generated-<name>`, kept like a newly created image (hermes-generated-images.js);
// anything else goes to `.unclaimed`, which no chat reads. Each move is one rename
// on one file system, so a run stopped anywhere is finished by the next. A user's
// own agent and the owner's keep the folder: all their chats are one person's.

const FOLDER = "generated-images";

const digest = async (file) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

// The work folder's generated-images/ as a real directory at its real place, or null.
async function oldImages(workspaces, assistantId) {
  if (!workspaces) return null;
  const workspace = path.join(workspaces, assistantId);
  const folder = path.join(workspace, FOLDER);
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
      real === path.join(ownReal, FOLDER);
    return inPlace ? folder : null;
  } catch {
    return null;
  }
}

// `size:sha256` of each file the agent shared → the chat it was first shared into
// (a mirror in a lead's chat is no chat of the agent's).
function sharedChats(a, assistantId) {
  const chats = new Map();
  for (const file of a.shared.rows("assistant_id=?", assistantId)) {
    if (typeof file.sha256 !== "string" || typeof file.from === "string") continue;
    const key = `${file.size}:${file.sha256}`;
    if (!chats.has(key)) chats.set(key, file.row.conversation_id);
  }
  return chats;
}

/**
 * Empties a shared Hermes agent's old `generated-images/` (`a`: AgentAttachments,
 * whose serial queue the caller holds; `unclaimed` moves what is left). Resolves with
 * how many entries moved.
 */
export async function migrateGeneratedImages(a, assistantId, unclaimed) {
  let agent;
  try {
    agent = a.store.getAssistant(assistantId);
  } catch {
    return 0;
  }
  if (!isShared(agent)) return 0;
  const folder = await oldImages(a.config?.workspaces, assistantId);
  if (!folder) return 0;
  const chats = sharedChats(a, assistantId);
  let moved = 0;
  for (const name of await fs.readdir(folder)) {
    const from = path.join(folder, name);
    const stat = await fs.lstat(from).catch(() => null);
    if (!stat?.isFile() || stat.nlink !== 1 || stat.size > MAX_SHARE_BYTES) continue;
    const chat = chats.get(`${stat.size}:${await digest(from)}`);
    if (!chat) continue;
    const target = await checkedChatFolder(a.config, [assistantId, chat], true).catch(
      () => null,
    );
    const to = target && path.join(target.path, generatedPrefix + name);
    if (!to || (await fs.lstat(to).catch(() => null))) continue;
    await fs.rename(from, to);
    moved++;
  }
  moved += await unclaimed(a, assistantId, { path: folder }, new Set());
  await fs.rmdir(folder).catch(() => {});
  return moved;
}
