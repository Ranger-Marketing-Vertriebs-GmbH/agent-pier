import fs from "node:fs/promises";
import path from "node:path";
import { assistantProblem } from "./assistant-validation.js";

// A Hermes agent keeps each chat's uploads in a folder of that chat alone,
// `<assistants>/chat-files/<agent id>/<chat id>/`, outside its work folder: a search
// of the work folder never reaches another chat's files, and on an agent shared with
// users its guard lets a turn read only its own chat's folder (hermes-home-guard.js).
// An OpenClaw agent keeps its uploads in its workspace's attachments/ (its file
// tools read only the workspace, and attachment-access.js names the chat of each).

const id = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
/** Files a migration found in an agent's old attachments/ without an index row. */
export const UNCLAIMED = ".unclaimed";
const ignoreExisting = (error) => {
  if (error.code !== "EEXIST") throw error;
};

/** Whether an agent keeps its chat uploads in per-chat folders (a Hermes agent). */
export const keepsChatFolders = (agent) => agent?.runtime === "hermes";

/** `<assistants>/chat-files`, beside the workspace root; `config.chatFiles` in tests. */
export function chatFilesRoot(config) {
  if (config?.chatFiles) return config.chatFiles;
  return config?.workspaces
    ? path.join(path.dirname(config.workspaces), "chat-files")
    : null;
}

/** The agent's folder of chat folders (not created), or null for an invalid id. */
export function agentChatPath(config, assistantId) {
  const root = chatFilesRoot(config);
  return root && id.test(assistantId || "") ? path.join(root, assistantId) : null;
}

/** One chat's folder (not created), or null for an invalid id. */
export function chatFolderPath(config, assistantId, conversationId) {
  const agent = agentChatPath(config, assistantId);
  return agent && id.test(conversationId || "") ? path.join(agent, conversationId) : null;
}

/**
 * The checked folder `parts` below the chat files root: every level a real directory
 * (never a link) at its real place below the root's real place, created 0700 when
 * `create`. `{ path, dev, ino, real }`; null without `create` when a level is
 * missing; refused (attachmentStorageUnsafe) for anything else.
 */
export async function checkedChatFolder(config, parts, create) {
  const root = chatFilesRoot(config);
  if (!root || !parts.every((part) => id.test(part) || part === UNCLAIMED))
    throw assistantProblem("unavailable", 503);
  try {
    if (create) await fs.mkdir(root, { mode: 0o700 }).catch(ignoreExisting);
    const [top, realRoot, parent] = await Promise.all([
      fs.lstat(root),
      fs.realpath(root),
      fs.realpath(path.dirname(root)),
    ]);
    if (!top.isDirectory() || realRoot !== path.join(parent, path.basename(root)))
      throw Error("unsafe");
    let folder = root;
    let stat = null;
    let real = realRoot;
    for (const [index, part] of parts.entries()) {
      folder = path.join(folder, part);
      if (create) await fs.mkdir(folder, { mode: 0o700 }).catch(ignoreExisting);
      [stat, real] = await Promise.all([
        fs.lstat(folder, { bigint: true }),
        fs.realpath(folder),
      ]);
      if (
        !stat.isDirectory() ||
        real !== path.join(realRoot, ...parts.slice(0, index + 1))
      )
        throw Error("unsafe");
    }
    return { path: folder, dev: stat.dev, ino: stat.ino, real };
  } catch (error) {
    if (!create && error.code === "ENOENT") return null;
    throw assistantProblem("attachmentStorageUnsafe", 409);
  }
}

/**
 * The checked chat folders of an agent (`key`: the chat id, or UNCLAIMED), at most
 * `limit`; entries of any other kind are skipped. Empty while the agent has none.
 */
export async function chatFoldersOf(config, assistantId, limit = 5000) {
  const top = await checkedChatFolder(config, [assistantId], false);
  if (!top) return [];
  const folders = [];
  for await (const entry of await fs.opendir(top.path)) {
    if (folders.length >= limit) break;
    if (!entry.isDirectory() || !(id.test(entry.name) || entry.name === UNCLAIMED))
      continue;
    const folder = await checkedChatFolder(config, [assistantId, entry.name], false);
    if (folder) folders.push({ ...folder, key: entry.name });
  }
  return folders;
}

/**
 * The agent placeholder folders (agent-placeholders.js) of a Hermes agent working in
 * `workspace`: `{agent.attachments}` is its folder of chat folders, withheld on an
 * agent shared with users, whose chats each read only their own. Null without an
 * absolute workspace.
 */
export function chatPlaceholderFolders(workspace, { shared = false } = {}) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) return null;
  const chats = agentChatPath(
    { workspaces: path.dirname(workspace) },
    path.basename(workspace),
  );
  return {
    "agent.workspace": workspace,
    ...(!shared && chats && { "agent.attachments": chats }),
  };
}
