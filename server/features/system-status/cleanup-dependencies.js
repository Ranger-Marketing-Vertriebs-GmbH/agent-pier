import path from "node:path";
import { entryStat, folderNames, measureTree, removeEntry } from "./safe-tree.js";
import { anyInside } from "./workspace-processes.js";
import { cleanupProblem } from "./cleanup-problem.js";

/*
 * Installed dependencies in the agents' workspaces (assistants/workspaces/<agent>):
 * every folder named node_modules, at any depth. A link named node_modules is not a
 * folder of the workspace and stays; the walk never follows a link and never looks
 * inside a node_modules folder for another one. The agent installs what it needs
 * again (npm install).
 */
const agentId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const MAX_DEPTH = 12;
const MAX_FOLDERS = 50_000;

export const workspacesFolder = (dataDir) =>
  path.join(dataDir, "assistants", "workspaces");

/** The node_modules folders below one workspace, as {parent, name}. */
export async function dependencyFolders(workspace) {
  const found = [];
  let folders = 0;
  const walk = async (folder, depth) => {
    for (const name of await folderNames(folder)) {
      const stat = await entryStat(folder, name);
      if (!stat?.isDirectory()) continue;
      if (name === "node_modules") found.push({ parent: folder, name });
      else if (depth < MAX_DEPTH && name !== ".git" && ++folders < MAX_FOLDERS)
        await walk(path.join(folder, name), depth + 1);
    }
  };
  await walk(workspace, 0);
  return found;
}

/** The workspace folders on disk, by agent id. */
export async function workspaceIds(dataDir) {
  const root = workspacesFolder(dataDir);
  const ids = [];
  for (const name of await folderNames(root))
    if (agentId.test(name) && (await entryStat(root, name))?.isDirectory())
      ids.push(name);
  return ids;
}

/** Size and count of one workspace's installed dependencies. */
export async function measureDependencies(dataDir, id) {
  const workspace = path.join(workspacesFolder(dataDir), id);
  const folders = await dependencyFolders(workspace);
  const budget = { entries: 2_000_000 };
  let bytes = 0,
    partial = false;
  for (const folder of folders) {
    const size = await measureTree(path.join(folder.parent, folder.name), budget);
    bytes += size.bytes;
    partial ||= size.partial;
  }
  return { folders, bytes, partial };
}

/**
 * Deletes every node_modules folder of one agent's workspace. `busy()` says whether
 * the agent works; `cwds()` lists the processes' working directories, and a process
 * inside the workspace refuses the deletion as well.
 */
export async function deleteDependencies(dataDir, id, { busy, cwds }) {
  if (!agentId.test(id || "")) throw cleanupProblem("notFound", 404);
  const root = workspacesFolder(dataDir);
  if (!(await entryStat(root, id))?.isDirectory()) throw cleanupProblem("notFound", 404);
  const workspace = path.join(root, id);
  if (await busy()) throw cleanupProblem("agentBusy", 409);
  let running;
  try {
    running = anyInside(await cwds(), workspace);
  } catch {
    throw cleanupProblem("processesUnreadable", 503);
  }
  if (running) throw cleanupProblem("agentBusy", 409);
  let removed = 0,
    skipped = 0,
    bytes = 0;
  for (const folder of await dependencyFolders(workspace)) {
    const full = path.join(folder.parent, folder.name);
    const size = await measureTree(full);
    try {
      // Checked again as found now: still a folder, never a link put in its place.
      if (await removeEntry(folder.parent, folder.name, (stat) => stat.isDirectory())) {
        removed++;
        bytes += size.bytes;
      } else skipped++;
    } catch {
      skipped++;
    }
  }
  return { removed, skipped, bytes };
}
