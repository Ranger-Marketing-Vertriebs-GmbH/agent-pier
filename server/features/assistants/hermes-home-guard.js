import fs from "node:fs";
import path from "node:path";
import { isShared, isUserAgent } from "../users/user-access.js";
import { fold } from "./team-plugin/tool-guard.js";
import { managedFolder } from "./team-plugin/managed-folder.js";
import { agentPrivateFolders, agentWorkspace } from "./runtimes/runtime-for.js";
import { chatFilesRoot } from "./chat-file-folders.js";

// A Hermes agent keeps more than its work folder: its HERMES_HOME holds every chat's
// sessions and the images of every chat's turns (the gateway's staged cache/images/
// and its committed cache/documents/native-inputs/), its HOME Hermes's own files, and
// AgentPier keeps each chat's uploads in a folder of that chat
// (`<assistants>/chat-files/<agent>/<chat>/`, chat-file-folders.js). An agent of
// restricted users (own or shared) reads and writes with its file and vision tools
// only its work folder and its chat folders: a user's own agent all of its own (each of its chats
// is hers), a shared one only the calling chat's, since there each chat is private to
// its person. Anything else (another agent's folders, the Hermes homes) or a search
// whose folder lies outside them is refused. On every Hermes agent a file call into
// the chat folders stays in the agent's own; on a shared one in the calling chat's.
// An OpenClaw agent reads only its workspace (tools.fs.workspaceOnly), whose
// attachments/ its own guard checks per chat (attachment-access.js).

/** The refusal the model reads for a read outside the allowed folders. */
export const homeRefusal =
  "Only your work folder and your chat's file folder are usable here: other folders hold other chats' or agents' files. Work with files in those.";
/** The refusal for a file call into another chat's or agent's file folder. */
export const chatFilesRefusal =
  "That file folder belongs to another chat. Use only the files sent in this chat.";

// The path a Hermes read names, as Hermes resolves it (tools/file_tools.py,
// tools/image_source.py): a literal `file://` prefix is dropped (no URL parsing), `~`
// is the agent's HOME, a relative path starts in the work folder; web and data
// addresses read nothing local. `~name` (another account's home) is "" (refused).
function target(value, workspace, home) {
  if (typeof value !== "string" || !value.trim()) return null;
  let spelled = value.trim();
  if (/^(?:https?|data):/i.test(spelled)) return null;
  if (/^file:\/\//i.test(spelled)) spelled = spelled.slice("file://".length);
  if (spelled === "~" || spelled.startsWith("~/"))
    spelled = path.join(home, spelled.slice(1));
  else if (spelled.startsWith("~")) return "";
  return path.resolve(workspace, spelled);
}

// The file system's own spelling of a path, existing or not: the nearest existing
// folder as the system spells it (realpath.native gives macOS's stored case and
// follows links), the missing rest below it; then case-folded, as APFS compares
// names (fold, as the attachments guard does).
function canonical(file) {
  const missing = [];
  let at = path.resolve(file);
  for (;;) {
    try {
      return fold(path.join(fs.realpathSync.native(at), ...missing.reverse()));
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return fold(path.join(at, ...missing.reverse()));
      missing.push(path.basename(at));
      at = parent;
    }
  }
}
// A path as spelled and as the system resolves it, both case-folded.
const forms = (file) => [fold(path.resolve(file)), canonical(file)];

const within = (root, target) => {
  const relative = path.relative(root, target);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** The paths a Hermes read names (`read_file`, `search_files`, `vision_analyze`), or null. */
export function readValues(toolName, args) {
  if (toolName === "vision_analyze") return [args.image_url];
  if (toolName === "read_file") return [args.path];
  return toolName === "search_files" ? [args.path ?? "."] : null;
}

/** The refusal for a search path that Hermes may search as several. */
export const splitSearchRefusal =
  "Search one folder at a time, with a path that holds no comma and no whitespace.";
/**
 * Whether Hermes may search `value` as several paths: one that does not exist is
 * split at commas or else at whitespace as Python's str.split() sees it, which also
 * counts \x1c-\x1f and \x85 (tools/file_operations_search.py
 * `_try_multi_path_search`). Such a path is refused on every agent rather than
 * mirrored part by part.
 */
export const splitsSearch = (value) =>
  typeof value === "string" && /[\s,\x1c-\x1f\x85]/u.test(value);

// The agent's work folder and HOME, or null when unknown.
function foldersOf(supervisor, agent) {
  const workspace = agentWorkspace(supervisor, agent);
  const folders = agentPrivateFolders(supervisor, agent);
  return workspace && folders ? { workspace, home: folders[1] } : null;
}

/**
 * On an agent of restricted users (isUserAgent): the refusal for a file call whose
 * paths (`values`: readValues, or a write's targets) leave its work folder and
 * `chatFolders` (its chat folders it may use: on a shared agent the calling chat's,
 * on a user's own its folder of chat folders), else null. A search counts by its
 * folder, which must lie inside one of them. Fails closed when the folders are
 * unknown or a path is no text. The owner's own agents use files as Hermes lets them.
 */
export function userReadRefusal(supervisor, agent, values, chatFolders = []) {
  if (!isUserAgent(agent)) return null;
  const folders = foldersOf(supervisor, agent);
  if (!folders) return homeRefusal;
  const roots = [folders.workspace, ...chatFolders].filter(Boolean).flatMap(forms);
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) return homeRefusal;
    const file = target(value, folders.workspace, folders.home);
    if (file === null) continue;
    if (!file) return homeRefusal;
    if (!forms(file).every((named) => roots.some((root) => within(root, named))))
      return homeRefusal;
  }
  return null;
}

/**
 * The refusal for a file call whose `values` lie in the chat folders but not in the
 * agent's own (`config`: AgentAttachments'), and on a shared agent not in the calling
 * chat's (`conversationId`, or null), else null.
 */
export function chatFolderRefusal(supervisor, agent, config, conversationId, values) {
  const root = chatFilesRoot(config);
  const folders = foldersOf(supervisor, agent);
  if (!root || !folders) return null;
  const roots = forms(root);
  for (const value of values) {
    const file = target(value, folders.workspace, folders.home);
    if (!file) continue;
    for (const named of forms(file))
      for (const base of roots) {
        if (!within(base, named)) continue;
        const [owner, chat] = path.relative(base, named).split(path.sep).filter(Boolean);
        if (owner !== fold(agent.id)) return chatFilesRefusal;
        if (isShared(agent) && (!conversationId || chat !== fold(conversationId)))
          return chatFilesRefusal;
      }
  }
  return null;
}

/**
 * Whether a search or read (`values`, readValues) covers or enters the folder `name`
 * of the agent's work folder while that folder exists: its secrets folder
 * (.agentpier/, agent-secrets.js), in which Hermes counts matches of hidden files
 * when a search finds none (`_zero_match_probe`), or the attachments/ a move into
 * the chat folders left behind (chat-file-migration.js); `holds` decides whether it
 * still matters (by default: it exists). True when unsure.
 */
export function searchCovers(
  supervisor,
  agent,
  values,
  name = managedFolder,
  holds = fs.existsSync,
) {
  const folders = foldersOf(supervisor, agent);
  if (!folders) return true;
  const folder = path.join(folders.workspace, name);
  if (!holds(folder)) return false;
  const inside = forms(folder);
  return values.some((value) => {
    const file = target(value, folders.workspace, folders.home);
    if (file === null) return false;
    if (!file) return true;
    return forms(file).some((named) =>
      inside.some((f) => within(named, f) || within(f, named)),
    );
  });
}
