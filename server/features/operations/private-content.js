import fs from "node:fs";
import path from "node:path";
import { stagePath } from "./stage-path.js";
import {
  isConfigFile,
  isCredentialFile,
  sealedSuffix,
} from "../assistants/backup-credentials.js";

/**
 * Private content beside the histories (docs/backups.md): agent chats, channel
 * messages, workspaces with their attachments and shared files, pipeline history and
 * unpinned artifacts. Backups archive it only sealed, like histories, in backups with
 * a passphrase and history; otherwise it is left out. Agent configuration stays
 * public, so a restore without it still brings back working agents.
 */
export const pipelineHistoryMember = "pipeline-runs/runs.sqlite";
/** The unpinned artifact records and their receipts, merged back by a restore. */
export const unpinnedArtifactsMember = "artifacts/unpinned.json";
/** Full copies of AgentPier's agent databases; a restore puts them in place. */
export const agentHistoryFolder = "assistant-history";
const artifactFile = /^artifacts\/generations\/[a-f0-9-]{36}\/\d{1,3}$/;
const agentDatabase = /^assistant-history\/[A-Za-z0-9_-]+\.sqlite$/;

// Below assistants/: workspaces (with the owner's attachments), files agents shared,
// OpenClaw's transcripts and session index, its media and its memory index.
const privateTree =
  /^(workspaces|shares|state\/media|state\/memory|state\/agents\/[^/]+\/sessions)(\/|$)/;
/** Whether `relative` (below assistants/) is or lies in a private folder. */
export const isPrivateAssistantTree = (relative) => privateTree.test(relative);
/**
 * Whether a database at `relative` (below assistants/) is private as a whole:
 * OpenClaw's state databases can hold conversations next to their credential
 * tables, whose rows still travel only in the credential sidecar.
 */
export const isPrivateAssistantDatabase = (relative) =>
  isPrivateAssistantTree(relative) || relative.startsWith("state/");

/**
 * Whether sealed member `name` may hold private content (seal record version 3).
 * `isAssistantMember` is passed in: assistant-backup.js imports this module.
 */
export function isPrivateContentPath(name, isAssistantMember) {
  if (
    name === pipelineHistoryMember ||
    name === unpinnedArtifactsMember ||
    artifactFile.test(name) ||
    agentDatabase.test(name)
  )
    return true;
  if (!name.startsWith("assistants/") || !isAssistantMember(name)) return false;
  const relative = name.slice("assistants/".length);
  return (
    isPrivateAssistantDatabase(relative) &&
    !isConfigFile(relative) &&
    !isCredentialFile(relative) &&
    !relative.endsWith(sealedSuffix)
  );
}
/** Public members a backup with a version 3 seal record never holds. */
export const isUnsealedPrivateContent = (name) =>
  name === pipelineHistoryMember ||
  name === unpinnedArtifactsMember ||
  agentDatabase.test(name) ||
  (name.startsWith("assistants/") &&
    !name.endsWith(sealedSuffix) &&
    isPrivateAssistantTree(name.slice("assistants/".length)));

// AgentPier's agent databases (assistants.sqlite, channels.sqlite): conversations,
// requests and their attempts, cached messages, attachment and share indexes, queued
// messages, routine results, memory notes, action history and Telegram messages.
const privateTables = [
  "agent_attachments",
  "assistant_actions",
  "assistant_memory_notes",
  "assistant_routine_events",
  "assistant_routine_results",
  "attempt_reviews",
  "attempts",
  "channel_inbox",
  "channel_outbox",
  "channel_strangers",
  "messages",
  "queued_messages",
  "requests",
  "conversations",
];
// Team records: policy and settings are configuration; teams, members, request
// contexts and lead requests are task history.
const teamConfiguration = ["policy", "settings"];

/**
 * Removes the private rows from database `db` (a copy), keeping configuration.
 * Returns whether the database has private tables at all.
 */
export function stripPrivateRows(db) {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
  const present = privateTables.filter((table) => tables.has(table));
  const teams = tables.has("assistant_team_records");
  if (!present.length && !teams) return false;
  db.exec("PRAGMA foreign_keys=OFF");
  for (const table of present) db.exec(`DELETE FROM "${table}"`);
  if (teams)
    db.prepare(
      `DELETE FROM assistant_team_records WHERE kind NOT IN (${teamConfiguration
        .map(() => "?")
        .join(",")})`,
    ).run(...teamConfiguration);
  return true;
}

/**
 * Puts the sealed full copies of AgentPier's agent databases in restore stage
 * `stage` in place of their public configuration copies.
 */
export function adoptAgentDatabases(stage) {
  const folder = path.join(stage, agentHistoryFolder);
  if (!fs.existsSync(folder)) return;
  for (const name of fs.readdirSync(folder).sort()) {
    const member = `${agentHistoryFolder}/${name}`;
    // The capsule named only such paths (isPrivateContentPath).
    if (!agentDatabase.test(member)) continue;
    const target = stagePath(stage, `assistants/${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.renameSync(stagePath(stage, member), target);
  }
  fs.rmSync(folder, { recursive: true, force: true });
}
export const privateContentOmissions = Object.freeze({
  history:
    "Agent chats, channel messages, workspaces and attachments, pipeline history and unpinned artifacts",
  // History chosen, but no passphrase: private content is only archived sealed.
  unsealed:
    "Agent chats, channel messages, workspaces and attachments, pipeline history and unpinned artifacts are only backed up in backups with a passphrase, and then encrypted",
});
