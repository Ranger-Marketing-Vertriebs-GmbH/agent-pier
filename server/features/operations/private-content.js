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
/**
 * Full copies of the agent databases split into a public configuration copy
 * (`assistant-history/<path below assistants/>`); a restore puts them in place.
 */
export const agentHistoryFolder = "assistant-history";
const artifactFile = /^artifacts\/generations\/[a-f0-9-]{36}\/\d{1,3}$/;
const isAgentDatabaseCopy = (name, isAssistantMember) =>
  name.startsWith(`${agentHistoryFolder}/`) &&
  isAssistantMember(`assistants/${name.slice(agentHistoryFolder.length + 1)}`);

// Below assistants/: workspaces (with the owner's attachments), files agents shared,
// OpenClaw's transcripts and session index, its media and its memory index. Files
// and databases there are private as a whole.
const privateTree =
  /^(workspaces|shares|state\/media|state\/memory|state\/agents\/[^/]+\/sessions)(\/|$)/;
/** Whether `relative` (below assistants/) is or lies in a private folder. */
export const isPrivateAssistantTree = (relative) => privateTree.test(relative);
// What a restore needs of OpenClaw's state folder in public: its configuration and
// copies, plugin skills, credential files (sealed in place, backup-credentials.js)
// and each agent's configuration folder. Anything else below state/, including what
// a later OpenClaw adds, is private; its databases are split (private-tables.js).
const publicState =
  /^state\/(openclaw\.json(\.[^/]+)?|plugin-skills\/.+|credentials\/.+|agents\/[^/]+\/agent\/.+)$/;
/** Whether file `relative` (below assistants/) is private content. */
export const isPrivateAssistantPath = (relative) =>
  privateTree.test(relative) ||
  (relative.startsWith("state/") && !publicState.test(relative));
/**
 * Runtime-only state below assistants/: OpenClaw's lock and temporary folders and
 * its lock and writer databases. Never captured; older archives still restore it.
 */
export const isRuntimeOnly = (relative) =>
  /^state\/(locks|tmp)(\/|$)|(-lock|\.generation-writer)\.sqlite$/.test(relative);

/**
 * Whether sealed member `name` may hold private content (seal record version 3).
 * `isAssistantMember` is passed in: assistant-backup.js imports this module.
 */
export function isPrivateContentPath(name, isAssistantMember) {
  if (
    name === pipelineHistoryMember ||
    name === unpinnedArtifactsMember ||
    artifactFile.test(name) ||
    isAgentDatabaseCopy(name, isAssistantMember)
  )
    return true;
  if (!name.startsWith("assistants/") || !isAssistantMember(name)) return false;
  const relative = name.slice("assistants/".length);
  return (
    (privateTree.test(relative) || relative.startsWith("state/")) &&
    !isConfigFile(relative) &&
    !isCredentialFile(relative) &&
    !relative.endsWith(sealedSuffix)
  );
}
/** Public members a backup with a version 3 seal record never holds. */
export const isUnsealedPrivateContent = (name) =>
  name === pipelineHistoryMember ||
  name === unpinnedArtifactsMember ||
  name.startsWith(`${agentHistoryFolder}/`) ||
  (name.startsWith("assistants/") &&
    !name.endsWith(sealedSuffix) &&
    isPrivateAssistantTree(name.slice("assistants/".length)));

/**
 * Puts the sealed full copies of the agent databases in restore stage `stage` in
 * place of their public configuration copies. The capsule named only paths below
 * assistants/ (isPrivateContentPath); stagePath guards each move.
 */
export function adoptAgentDatabases(stage) {
  const folder = path.join(stage, agentHistoryFolder);
  if (!fs.existsSync(folder)) return;
  for (const entry of fs.readdirSync(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relative = path
      .relative(folder, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/");
    const target = stagePath(stage, `assistants/${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.renameSync(stagePath(stage, `${agentHistoryFolder}/${relative}`), target);
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
