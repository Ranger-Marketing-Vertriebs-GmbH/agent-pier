import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { inFolder } from "../assistants/project-open.js";
import { entryStat, folderNames, measureTree, removeEntry } from "./safe-tree.js";
import { anyInside } from "./workspace-processes.js";
import { cleanupProblem } from "./cleanup-problem.js";

/*
 * Installed dependencies in the agents' workspaces (assistants/workspaces/<agent>):
 * every folder named node_modules, at any depth. A link named node_modules is not a
 * folder of the workspace and stays; the walk never follows a link and never looks
 * inside a node_modules folder for another one. The agent installs what it needs
 * again (npm install). A folder is first renamed in its parent to
 * `.node_modules-deleting-<random>`, atomically, so the agent never sees a half
 * deleted node_modules; a deletion a restart interrupted is finished by the startup
 * sweep (sweepDependencies).
 */
const DELETING = ".node_modules-deleting-";
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
      else if (name.startsWith(DELETING)) continue;
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

// Renames `parent/name` to a fresh deleting name in the parent as opened.
async function setAside(parent, name) {
  const aside = DELETING + randomBytes(8).toString("hex");
  await inFolder(parent, async (at) => {
    const stat = await fsp.lstat(await at(name));
    if (!stat.isDirectory())
      throw Object.assign(Error("Not a folder."), { code: "ENOTDIR" });
    await fsp.rename(await at(name), await at(aside));
  });
  return aside;
}

/**
 * Deletes every node_modules folder of one agent's workspace. `busy()` says whether
 * the agent works; `cwds()` lists the processes' working directories, and a process
 * inside the workspace refuses the deletion as well. Both are asked again before
 * each folder; a folder found busy then stays and counts as skipped.
 */
export async function deleteDependencies(dataDir, id, { busy, cwds }) {
  if (!agentId.test(id || "")) throw cleanupProblem("notFound", 404);
  const root = workspacesFolder(dataDir);
  // The workspace folder found on disk names the path; the request's id only selects it.
  const name = (await workspaceIds(dataDir)).find((found) => found === id);
  if (!name) throw cleanupProblem("notFound", 404);
  const workspace = path.join(root, name);
  const idle = async () => {
    if (await busy()) return false;
    try {
      return !anyInside(await cwds(), workspace);
    } catch {
      throw cleanupProblem("processesUnreadable", 503);
    }
  };
  if (!(await idle())) throw cleanupProblem("agentBusy", 409);
  let removed = 0,
    skipped = 0,
    bytes = 0,
    first = true;
  for (const folder of await dependencyFolders(workspace)) {
    if (!first && !(await idle())) {
      skipped++;
      continue;
    }
    first = false;
    const size = await measureTree(path.join(folder.parent, folder.name));
    try {
      const aside = await setAside(folder.parent, folder.name);
      await removeEntry(folder.parent, aside, (stat) => stat.isDirectory());
      removed++;
      bytes += size.bytes;
    } catch {
      skipped++;
    }
  }
  return { removed, skipped, bytes };
}

/** Startup: finishes deletions a restart interrupted (`.node_modules-deleting-*`). */
export async function sweepDependencies(dataDir) {
  const root = workspacesFolder(dataDir);
  for (const id of await workspaceIds(dataDir)) {
    const walk = async (folder, depth) => {
      for (const name of await folderNames(folder)) {
        const stat = await entryStat(folder, name);
        if (!stat?.isDirectory()) continue;
        if (name.startsWith(DELETING))
          await removeEntry(folder, name, (now) => now.isDirectory()).catch(() => {});
        else if (name !== "node_modules" && name !== ".git" && depth < MAX_DEPTH)
          await walk(path.join(folder, name), depth + 1);
      }
    };
    await walk(path.join(root, id), 0);
  }
}
