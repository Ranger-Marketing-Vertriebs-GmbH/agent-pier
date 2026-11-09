// Chat uploads of a shared agent (agent-attachments.js) all land in one folder of its
// workspace, attachments/. Every chat with a shared agent is private to its person,
// so a turn there reads, changes or shares only the files sent in its own chat: the
// plugin asks for every file tool call that names that folder (tool-guard.js
// attachmentCall), and agentpier_share_file checks the same (agent-shares.js).
// OpenClaw's inbound media (team-plugin/attachment-guard.js) name no chat: on a
// shared agent no turn uses them.
import { isShared } from "../users/user-access.js";
import { fold } from "./team-plugin/tool-guard.js";
import { NO_CHAT, inboundMedia } from "./team-plugin/attachment-guard.js";

const FOLDER = "attachments";

/**
 * The stored name of the file a workspace-relative path names in attachments/ ("" for
 * the folder itself), or null when the path lies elsewhere. Case variants count, as
 * the file system may not tell them apart.
 */
export function attachmentFile(relative) {
  const parts = String(relative)
    .split(/[\\/]+/)
    .filter((part) => part && part !== ".");
  if (!parts.length || fold(parts[0]) !== FOLDER) return null;
  return parts.slice(1).join("/");
}

/**
 * attachmentFile, or NO_CHAT for a path through OpenClaw's inbound media, which
 * attachmentsAllowed admits only on an agent that is not shared.
 */
export const chatFile = (relative) =>
  inboundMedia(String(relative)) ? NO_CHAT : attachmentFile(relative);

/**
 * Whether a turn in `conversationId` may use these files of the agent's attachments
 * folder: any on an agent that is not shared, on a shared one only its own chat's.
 */
export function attachmentsAllowed(store, agent, conversationId, files) {
  if (!isShared(agent)) return true;
  if (!files.length) return true;
  if (typeof conversationId !== "string") return false;
  const own = new Set(
    store.db
      .prepare(
        "SELECT body FROM agent_attachments WHERE assistant_id=? AND conversation_id=?",
      )
      .all(agent.id, conversationId)
      .map((row) => JSON.parse(row.body).file)
      .filter((file) => typeof file === "string")
      .map(fold),
  );
  return files.every((file) => !!file && own.has(fold(file)));
}
