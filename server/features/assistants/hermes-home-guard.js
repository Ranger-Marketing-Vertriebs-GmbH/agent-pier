import fs from "node:fs";
import path from "node:path";
import { isShared } from "../users/user-access.js";
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
// tools/vision_tools.py): `~` is the agent's HOME, a relative path starts in the
// work folder, a file: URL names a local file; web addresses read nothing local.
function target(value, workspace, home) {
  if (typeof value !== "string" || !value.trim()) return null;
  let spelled = value.trim();
  if (/^https?:\/\//i.test(spelled) || /^data:/i.test(spelled)) return null;
  if (/^file:\/\//i.test(spelled)) {
    try {
      spelled = decodeURIComponent(new URL(spelled).pathname);
    } catch {
      return "";
    }
  }
  if (spelled === "~" || spelled.startsWith("~/"))
    spelled = path.join(home, spelled.slice(1));
  return path.resolve(workspace, spelled);
}

const within = (root, target) => {
  const relative = path.relative(root, target);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
};
// The path and, when it exists, the file or folder it resolves to.
function spellings(file) {
  try {
    const real = fs.realpathSync(file);
    return real === file ? [file] : [file, real];
  } catch {
    return [file];
  }
}

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
  const roots = folders.flatMap(spellings);
  for (const named of spellings(file)) {
    if (roots.some((root) => within(root, named))) return homeRefusal;
    if (toolName === "search_files" && roots.some((root) => within(named, root)))
      return homeRefusal;
  }
  return null;
}
