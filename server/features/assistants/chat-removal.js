import fs from "node:fs";
import path from "node:path";
import { RoutineResults } from "./routine-results.js";
import { chatBusy, chatProblem } from "./agent-chats.js";
import { assistantProblem } from "./assistant-validation.js";
import { mainConversation } from "./routine-targets.js";
import { purgeTranscriptArchives } from "./transcript-archives.js";

/**
 * Archive, restore and delete of an agent chat (AGENTPIER-181). Archive state lives
 * in AgentPier: an archived chat leaves the list, stays readable and takes no turn
 * until it is restored. Delete removes the chat, its native session and transcript
 * archives, and everything AgentPier kept of it. The person's main chat, where
 * reminders, routines, check-ins and Telegram deliver, is never archived or deleted,
 * and neither is a chat while a turn runs or a message waits in it.
 */

/** The retained `.jsonl.deleted.*` archives of a deleted native session. */
export function deletedTranscripts(stateDir, runtimeAgentId, sessionId = null) {
  const folder = path.join(stateDir, "agents", runtimeAgentId, "sessions");
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => /\.jsonl\.deleted\./.test(name))
    .filter((name) => !sessionId || name.startsWith(`${sessionId}.`))
    .map((name) => path.join(folder, name));
}

const now = () => new Date().toISOString();

// A chat a person may archive or delete now: not her main chat (a chat stored before
// several chats existed becomes it here, as on any read), not a team member's chat,
// which is its team's, and nothing under way.
function removable(service, conversation) {
  if (conversation.userReleased) throw assistantProblem("notFound", 404);
  if (service.store.getAssistant(conversation.assistantId).teamMemberId)
    throw assistantProblem("invalid");
  const person = typeof conversation.userId === "string" ? conversation.userId : null;
  if (
    conversation.main === true ||
    mainConversation(service.store, conversation.assistantId, person)?.id ===
      conversation.id
  )
    throw chatProblem("CHAT_MAIN");
  if (chatBusy(service, conversation.id)) throw chatProblem("CHAT_BUSY");
}

/** Archives a chat; its open views close (conversation-feeds.js). */
export function archiveChat(service, conversationId) {
  return service.admit(() => {
    const conversation = service.store.getConversation(conversationId);
    removable(service, conversation);
    if (!conversation.archivedAt)
      service.store.updateConversation(conversationId, { archivedAt: now() });
    service.feeds.end(conversationId);
    service.changed({ conversationId });
    return service.chats.summary(conversationId);
  });
}

/** Restores an archived chat to the list; it takes turns again. */
export function restoreChat(service, conversationId) {
  return service.admit(() => {
    const conversation = service.store.getConversation(conversationId);
    if (conversation.userReleased) throw assistantProblem("notFound", 404);
    if (conversation.archivedAt)
      service.store.updateConversation(conversationId, { archivedAt: null });
    service.changed({ conversationId });
    return service.chats.summary(conversationId);
  });
}

/**
 * Deletes a chat: marked deleted first (every route then answers 404), its open views
 * closed, AgentPier's copies of it forgotten, and its native session deleted with its
 * transcript. A Gateway that is away deletes the session at its next start
 * (deleteReleasedSessions, users/user-release.js).
 */
export function deleteChat(service, conversationId) {
  return service.admit(async () => {
    const conversation = service.store.getConversation(conversationId);
    removable(service, conversation);
    service.store.forgetConversation(conversationId, {
      deletedAt: now(),
      archivedAt: conversation.archivedAt || now(),
      nativeDeletePending: true,
    });
    service.feeds.end(conversationId);
    await forgetChat(service, conversation);
    service.memoryNotes?.forget(conversationId);
    await deleteNativeSession(service, conversation);
    service.changed();
    return conversation;
  });
}

/**
 * What AgentPier keeps of a chat: its cached messages, request texts, files (uploads
 * and what the agent shared), the results of reminders and routines, its hidden
 * long-chat hints and its work goals.
 */
export async function forgetChat(assistants, conversation) {
  try {
    assistants.queued?.take(conversation.id);
  } catch {
    /* Nothing queued. */
  }
  await removeFiles(assistants, conversation).catch(() => {});
  assistants.store.forgetMessages(conversation.id);
  assistants.ledger.forgetTexts(conversation.id);
  new RoutineResults(assistants.store.db).forget(conversation.id);
  assistants.longChats?.forget(conversation.id);
  assistants.teams?.goals?.forget(conversation.id);
}

/**
 * Deletes a chat's native session with its transcript, then the transcript archives
 * OpenClaw keeps of it: the rows in the agent's database and the files in its sessions
 * folder (transcript-archives.js). The session's id names the archive; it is recorded
 * on the chat before the delete, so a retry after a delete whose answer was lost, or
 * after a restart, still finds the archive once the session is gone. The mark goes
 * once the session and its archives are; a history read that ran across the
 * deletion may have cached the chat again, so it is forgotten once more. Returns
 * whether the session is gone.
 */
export async function deleteNativeSession(assistants, conversation) {
  const client = assistants.runtime.client;
  if (!client?.ready) return false;
  const sessionId = await nativeSessionId(assistants, conversation);
  if (sessionId === undefined) return false;
  try {
    await client.call("sessions.delete", {
      key: conversation.runtimeSessionKey,
      deleteTranscript: true,
    });
  } catch {
    return false;
  }
  const agent = agentOf(assistants, conversation.assistantId);
  const state = assistants.runtime.paths?.state;
  if (agent && state) {
    try {
      purgeTranscriptArchives(state, agent.runtimeAgentId, {
        sessionKey: conversation.runtimeSessionKey,
        sessionId,
      });
    } catch (error) {
      // Never a path or a row: SQLite's code and fixed text at most. The mark stays,
      // and the next Gateway start tries again (deleteReleasedSessions).
      console.error(
        "Transcript archive purge failed:",
        error?.code ?? error?.name,
        ...(error?.errcode === undefined ? [] : [error.errcode, error.errstr]),
      );
      return false;
    }
    if (sessionId) {
      for (const file of deletedTranscripts(state, agent.runtimeAgentId, sessionId))
        fs.rmSync(file, { force: true });
      if (deletedTranscripts(state, agent.runtimeAgentId, sessionId).length) return false;
    }
  }
  assistants.store.updateConversation(conversation.id, { nativeDeletePending: false });
  await forgetChat(assistants, conversation);
  return true;
}

export const archivePurgeMarker = "transcript-archive-purge";

/**
 * Once: chats deleted, and released users' chats, before AgentPier removed OpenClaw's
 * archive rows (AGENTPIER-220; 2026.10.3 kept them too) are marked
 * `nativeDeletePending` again, so the next pass of deleteReleasedSessions deletes
 * their session (gone already: 2026.10.7 answers `deleted: false`) and purges their
 * archives. Returns how many it marked.
 */
export function markArchivePurges(store) {
  const { db } = store;
  db.exec(
    "CREATE TABLE IF NOT EXISTS assistant_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  if (
    db.prepare("SELECT 1 FROM assistant_migrations WHERE name=?").get(archivePurgeMarker)
  )
    return 0;
  let marked = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const c of store.listConversations({ deleted: true }))
      if (
        (c.deletedAt || c.userReleased) &&
        c.runtimeSessionKey &&
        !c.nativeDeletePending
      ) {
        store.updateConversation(c.id, { nativeDeletePending: true });
        marked++;
      }
    db.prepare("INSERT INTO assistant_migrations VALUES(?,?)").run(
      archivePurgeMarker,
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return marked;
}

// The native session's id: the one recorded on the chat, else described and recorded
// now. Null when the Gateway knows no session for the chat (nothing to archive), and
// undefined when it could not say: the deletion waits for the next try then.
async function nativeSessionId(assistants, conversation) {
  const recorded = assistants.store.storedConversation(conversation.id).nativeSessionId;
  if (typeof recorded === "string" && recorded) return recorded;
  let sessionId;
  try {
    sessionId =
      (
        await assistants.runtime.client.call("sessions.describe", {
          key: conversation.runtimeSessionKey,
        })
      )?.session?.sessionId ?? null;
  } catch {
    return undefined;
  }
  if (typeof sessionId !== "string" || !sessionId) return null;
  assistants.store.updateConversation(conversation.id, { nativeSessionId: sessionId });
  return sessionId;
}

function agentOf(assistants, id) {
  try {
    return assistants.store.getAssistant(id);
  } catch {
    return null;
  }
}

// The files of a chat: uploads and what the agent shared into it.
async function removeFiles(assistants, conversation) {
  const attachments = assistants.attachments;
  const files = attachments.rows(
    "SELECT * FROM agent_attachments WHERE conversation_id=?",
    conversation.id,
  );
  const folder = await attachments.folder(conversation.assistantId, false);
  for (const file of files) {
    if (file.shared)
      await attachments.shared.remove(conversation.id, file.id).catch(() => {});
    if (folder && !file.shared) await attachments.remove(file, folder.path);
    else attachments.db.prepare("DELETE FROM agent_attachments WHERE id=?").run(file.id);
  }
}
