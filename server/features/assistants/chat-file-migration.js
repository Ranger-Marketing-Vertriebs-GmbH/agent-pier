import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SHARED } from "./agent-share-store.js";
import { UNCLAIMED, checkedChatFolder } from "./chat-file-folders.js";
import { migrateGeneratedImages } from "./hermes-image-migration.js";

// A Hermes agent's uploads from before per-chat folders (chat-file-folders.js) lie in
// its workspace's attachments/, where a search of the work folder reaches every
// chat's files. Before each start of its process set they move into their chats'
// folders; files no row names go to `.unclaimed`, which no chat reads. Moving stays
// on one file system (both below <data>/assistants), so each rename is atomic, and a
// run interrupted anywhere is finished by the next one.

const digest = async (file) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

// Whether `target` already holds the row's bytes (a run stopped after its rename).
async function holds(target, file) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.size !== file.size || stat.nlink !== 1) return false;
  return (await digest(target).catch(() => null)) === file.sha256;
}

/**
 * Moves the agent's attachments/ into its chat folders (`a`: AgentAttachments, whose
 * serial queue the caller holds). Each row's copy moves to its chat's folder and the
 * row is marked `chat`; a copy that is in neither place goes as the quota check lets
 * it go (an unsent row is dropped, a sent one marked gone). A sent chat row an older
 * AgentPier marked gone while its copy stayed in the chat folder is back, and a
 * shared agent's old generated-images/ empties (hermes-image-migration.js). Resolves
 * with how many files moved.
 */
export async function migrateChatFiles(a, assistantId) {
  if (!a.chatFolders(assistantId)) return 0;
  await restoreGone(a, assistantId);
  let moved = 0;
  try {
    moved = await moveAttachments(a, assistantId);
  } finally {
    // Then, also when that failed, a shared agent's images an older AgentPier kept in
    // its work folder; their move never throws.
    moved += await migrateGeneratedImages(a, assistantId);
  }
  return moved;
}

async function moveAttachments(a, assistantId) {
  let moved = 0;
  // Without attachments/ only rows whose copy a stopped move left in its chat's
  // folder are marked.
  const old = await a.folder(assistantId, false);
  const arriving = a.videos.arriving(assistantId);
  const waiting = new Set();
  for (const file of a.rows(
    `SELECT * FROM agent_attachments WHERE assistant_id=? AND (request_id IS NULL OR request_id NOT LIKE '${SHARED}%')`,
    assistantId,
  )) {
    if (file.chat || file.gone) continue;
    if (arriving.has(file.file)) {
      waiting.add(file.file);
      continue;
    }
    let folder;
    try {
      folder = await checkedChatFolder(
        a.config,
        [assistantId, file.row.conversation_id],
        !!old,
      );
    } catch {
      // Its chat has no safe folder: the copy stays where it is.
      waiting.add(file.file);
      continue;
    }
    if (!folder) continue;
    const to = path.join(folder.path, file.file);
    if (!old) {
      if (await holds(to, file)) markChat(a, file);
      continue;
    }
    const from = path.join(old.path, file.file);
    const source = await fs.lstat(from).catch(() => null);
    const present = !!(await fs.lstat(to).catch(() => null));
    if (source?.isFile() && !present) {
      await fs.rename(from, to);
      moved++;
    }
    if ((source?.isFile() && !present) || (await holds(to, file))) markChat(a, file);
    else if (file.row.request_id === null)
      a.db.prepare("DELETE FROM agent_attachments WHERE id=?").run(file.id);
    else a.markGone(file);
  }
  if (!old) return moved;
  moved += await unclaimed(a, assistantId, old, waiting);
  // Empty now, unless a copy had to stay.
  await fs.rmdir(old.path).catch(() => {});
  return moved;
}

/**
 * Removes the copy a move stopped between its rename and the row's mark left in the
 * chat folder of an unmarked row (`a`: AgentAttachments), as the row goes.
 */
export async function removeStranded(a, file) {
  if (file.chat || !a.chatFolders(file.row.assistant_id)) return;
  const folder = await a.folderOf({ ...file, chat: true }).catch(() => null);
  if (folder) await fs.rm(path.join(folder.path, file.file), { force: true });
}

const markChat = (a, file) =>
  a.db
    .prepare("UPDATE agent_attachments SET body=? WHERE id=?")
    .run(JSON.stringify({ ...JSON.parse(file.row.body), chat: true }), file.id);

// An older AgentPier, run after the move, finds no copy in attachments/ and marks
// each sent row gone; a copy still in its chat folder with its bytes is back.
async function restoreGone(a, assistantId) {
  for (const file of a.rows(
    `SELECT * FROM agent_attachments WHERE assistant_id=? AND request_id IS NOT NULL AND request_id NOT LIKE '${SHARED}%'`,
    assistantId,
  )) {
    if (!file.chat || !file.gone) continue;
    const folder = await a.folderOf(file).catch(() => null);
    if (!folder || !(await holds(path.join(folder.path, file.file), file))) continue;
    const { gone: _gone, ...body } = JSON.parse(file.row.body);
    a.db
      .prepare("UPDATE agent_attachments SET body=? WHERE id=?")
      .run(JSON.stringify(body), file.id);
  }
}

// Everything left in attachments/ that no row still needs goes to `.unclaimed`.
async function unclaimed(a, assistantId, old, waiting) {
  const names = [];
  for await (const entry of await fs.opendir(old.path))
    if (!waiting.has(entry.name)) names.push(entry.name);
  if (!names.length) return 0;
  const folder = await checkedChatFolder(a.config, [assistantId, UNCLAIMED], true);
  for (const name of names) {
    const taken = await fs.lstat(path.join(folder.path, name)).catch(() => null);
    const target = taken ? `${randomUUID().slice(0, 8)}-${name}` : name;
    await fs.rename(path.join(old.path, name), path.join(folder.path, target));
  }
  return names.length;
}
