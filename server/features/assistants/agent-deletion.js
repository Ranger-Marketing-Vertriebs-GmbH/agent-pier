import fs from "node:fs";
import path from "node:path";
import { agentProfileName } from "./openclaw-config/browser-profiles.js";
import { configWrite } from "./openclaw-config/live-patch.js";

/**
 * What a permanent delete of an archived agent removes (AGENTPIER-260), store by
 * store. Every step may run again: a start resumes a delete a crash interrupted
 * (agent-lifecycle.js resume), so each one removes what is still there and never
 * fails on what is gone. Project memory, pipeline and coding runs it started,
 * worktrees, shared projects, the audit log and backups are not the agent's and stay.
 */

const managed = new Set(["AGENTS.md", "SOUL.md", "IDENTITY.md", "BOOTSTRAP.md"]);
const memoryNames = new Set(["MEMORY.md", "USER.md"]);

const hasTable = (db, table) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const remove = (db, table, where, ...args) => {
  if (hasTable(db, table)) db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args);
};
const count = (db, table, where, ...args) =>
  hasTable(db, table)
    ? db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n
    : 0;

/** The folders AgentPier and OpenClaw keep for the agent. */
export function agentFolders(paths, agent) {
  const profile = agentProfileName(agent.id);
  return [
    path.join(paths.workspaces, agent.id),
    // Files the agent shared with its chats (agent-share-store.js).
    path.join(path.dirname(paths.workspaces), "shares", agent.id),
    // Dreaming's copies of its memory (dreaming-backups.js).
    path.join(paths.root, "memory-backups", agent.runtimeAgentId),
    // OpenClaw's agent state: sessions, transcripts and their archives.
    path.join(paths.state, "agents", agent.runtimeAgentId),
    ...(profile ? [path.join(paths.state, "browser", profile)] : []),
  ];
}

// Regular files below `dir`, never through a link.
function files(dir, relative = "") {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(dir, relative), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) return files(dir, name);
    return entry.isFile() ? [name] : [];
  });
}

/**
 * What the owner loses, as counts: chats, routines (reminders, routines, check-ins
 * and hooks), notes and memory files, other workspace files, and the temporary
 * members deleted with a lead.
 */
export function deletionCounts({ assistants, paths }, agents) {
  const db = assistants.store.db;
  const totals = { chats: 0, routines: 0, memoryFiles: 0, workspaceFiles: 0 };
  for (const agent of agents) {
    totals.chats += assistants.store
      .listConversations()
      .filter((c) => c.assistantId === agent.id).length;
    totals.routines +=
      count(
        db,
        "assistant_reminder_bindings",
        "assistant_id=? AND json_extract(body,'$.state') NOT IN ('removed','revoked')",
        agent.id,
      ) + count(db, "assistant_hooks", "assistant_id=?", agent.id);
    if (!paths?.workspaces) continue;
    for (const file of files(path.join(paths.workspaces, agent.id))) {
      const [top] = file.split(path.sep);
      if (memoryNames.has(file) || top === "memory") totals.memoryFiles++;
      else if (!managed.has(file) && top !== ".agentpier") totals.workspaceFiles++;
    }
  }
  return { ...totals, members: agents.length - 1 };
}

/**
 * The agent in the running Gateway: OpenClaw's own journaled `agents.delete` drops
 * its configuration entry, every cron job of the agent (AgentPier's reminders,
 * routines and check-ins, and jobs it made itself) and its exec approvals. Its files
 * stay for the purge below: with `deleteFiles` OpenClaw would move them into a trash
 * folder instead of deleting them. An agent the Gateway no longer lists is done.
 */
export async function removeFromGateway(client, runtimeAgentId) {
  const { agents = [] } = await client.call("agents.list", {});
  if (agents.some((entry) => entry.id === runtimeAgentId))
    await configWrite(client, () =>
      client.call("agents.delete", { agentId: runtimeAgentId, deleteFiles: false }),
    );
}

// Its rows in the agents' database, children before the rows they reference.
function removeRows(db, id, channelIds) {
  const chats = "SELECT id FROM conversations WHERE assistant_id=?";
  const requests = `SELECT id FROM requests WHERE conversation_id IN (${chats})`;
  db.exec("BEGIN IMMEDIATE");
  try {
    remove(
      db,
      "attempt_reviews",
      `attempt_id IN (SELECT id FROM attempts WHERE request_id IN (${requests}))`,
      id,
    );
    remove(db, "attempts", `request_id IN (${requests})`, id);
    remove(
      db,
      "assistant_team_records",
      `kind='context' AND id IN (SELECT 'context:' || id FROM requests WHERE conversation_id IN (${chats}))`,
      id,
    );
    remove(db, "requests", `conversation_id IN (${chats})`, id);
    for (const table of [
      "messages",
      "queued_messages",
      "assistant_memory_notes",
      "assistant_routine_results",
      "assistant_long_chat_dismissals",
    ])
      remove(db, table, `conversation_id IN (${chats})`, id);
    remove(
      db,
      "assistant_member_long_chats",
      `member_id=? OR conversation_id IN (${chats})`,
      id,
      id,
    );
    remove(
      db,
      "assistant_team_records",
      `kind='work-goal' AND json_extract(body,'$.conversationId') IN (${chats})`,
      id,
    );
    for (const channelId of channelIds)
      remove(db, "channel_follow_ups", "channel_id=?", channelId);
    remove(db, "agent_attachments", "assistant_id=?", id);
    remove(db, "conversations", "assistant_id=?", id);
    remove(
      db,
      "assistant_routine_events",
      "binding_id IN (SELECT id FROM assistant_reminder_bindings WHERE assistant_id=?)",
      id,
    );
    remove(db, "assistant_reminder_bindings", "assistant_id=?", id);
    remove(db, "assistant_hook_events", "assistant_id=?", id);
    remove(db, "assistant_hooks", "assistant_id=?", id);
    // Pending approvals, and its SSH and SFTP jobs with their results.
    remove(db, "assistant_actions", "assistant_id=?", id);
    // Grants: projects, SSH, secrets and GitHub.
    remove(db, "assistant_access", "assistant_id=?", id);
    remove(db, "assistant_lead_shares", "member_assistant_id=? OR lead_id=?", id, id);
    // A lead's teams, member records and requests with their texts; its policy; a
    // member's own record.
    remove(
      db,
      "assistant_team_records",
      "kind='text' AND parent_id IN (SELECT id FROM assistant_team_records WHERE parent_id=?)",
      id,
    );
    remove(
      db,
      "assistant_team_records",
      "parent_id=? OR id=? OR id=?",
      id,
      id,
      `policy:${id}`,
    );
    remove(db, "assistants", "id=?", id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Removes one agent marked `deleting` everywhere; safe to run again. */
export async function purgeAgent(services, agent) {
  const { assistants, channels, mcpServers, paths, dataDir } = services;
  await assistants.browsers?.stopAgent?.(agent.id).catch(() => {});
  await removeFromGateway(assistants.runtime.client, agent.runtimeAgentId);
  // Its Telegram channels with their inbox and pending outbox.
  const own = (channels?.store.list() || []).filter((c) => c.assistantId === agent.id);
  for (const channel of own) await channels.forget(channel.id);
  try {
    mcpServers?.setBindings("agent", agent.id, []);
  } catch {
    /* A store without bindings for it. */
  }
  // Folders first: the record that finds them goes last.
  if (paths)
    for (const folder of agentFolders(paths, agent))
      fs.rmSync(folder, { recursive: true, force: true });
  // Its SSH execution lock (agent-ssh.js).
  if (dataDir)
    for (const suffix of ["", "-wal", "-shm"])
      fs.rmSync(path.join(dataDir, "ssh", "agents", `${agent.id}.lock.sqlite${suffix}`), {
        force: true,
      });
  removeRows(
    assistants.store.db,
    agent.id,
    own.map((c) => c.id),
  );
  assistants.config?.applied?.delete(agent.id);
}
