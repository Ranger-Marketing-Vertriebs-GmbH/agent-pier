import fs from "node:fs";
import path from "node:path";
import { isShared } from "../users/user-access.js";
import { fold } from "./team-plugin/tool-guard.js";
import { agentPrivateFolders, agentWorkspace } from "./runtimes/runtime-for.js";

// A Hermes agent keeps more than its work folder: its HERMES_HOME holds every chat's
// sessions and the images of every chat's turns (the gateway's staged
// cache/images/ and its committed cache/documents/native-inputs/), and its HOME
// Hermes's own files. On an agent shared with users each chat is private to its
// person (attachment-access.js), so its file and vision tools never read those
// folders: a read inside one, or a search whose folder holds one, is refused. An
// OpenClaw agent reads only its workspace (tools.fs.workspaceOnly), so nothing it
// may read holds another chat's images. An agent not shared with users has only the
// owner's chats, which may read each other's attachments on OpenClaw too; its reads
// stay Hermes's own.

/** The refusal the model reads. */
export const homeRefusal =
  "This agent's runtime folders are not readable here: they hold other chats' files. Work with files in your work folder.";

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

const within = (root, target) => {
  const relative = path.relative(root, target);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * Whether a read of a shared Hermes agent (`read_file`, `search_files`,
 * `vision_analyze`) names one of its private folders: the refusal, else null. A
 * search is refused for a folder that holds one. Fails closed when the folders are
 * unknown.
 */
export function privateFolderRefusal(supervisor, agent, toolName, args) {
  if (!isShared(agent)) return null;
  const value =
    toolName === "vision_analyze"
      ? args.image_url
      : toolName === "search_files"
        ? (args.path ?? ".")
        : toolName === "read_file"
          ? args.path
          : undefined;
  if (value === undefined) return null;
  const workspace = agentWorkspace(supervisor, agent);
  const folders = agentPrivateFolders(supervisor, agent);
  if (!workspace || !folders) return homeRefusal;
  const file = target(value, workspace, folders[1]);
  if (file === null) return null;
  if (!file) return homeRefusal;
  // Both as spelled and as the system resolves them, case-folded.
  const roots = folders.flatMap((root) => [fold(path.resolve(root)), canonical(root)]);
  for (const named of [fold(file), canonical(file)]) {
    if (roots.some((root) => within(root, named))) return homeRefusal;
    if (toolName === "search_files" && roots.some((root) => within(named, root)))
      return homeRefusal;
  }
  return null;
}
