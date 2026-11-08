import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDirectory, validDirectoryName } from "../../lib/directories.js";
import { projectScope } from "../memory/project-scope.js";
import { assistantProblem } from "../assistants/assistant-validation.js";

const run = promisify(execFile);
const openFolder = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const unavailable = () => assistantProblem("projectFolderUnavailable", 409);
const NAME_LIMIT = 60;
const SUFFIX_LIMIT = 200;

/** `git init` in a new project folder, with the owner's normal Git environment. */
export async function initRepository(cwd) {
  await run("git", ["init", "--quiet"], { cwd, timeout: 10000 });
}

/** A valid folder name from free text: one line, at most 60 characters, else `Rebuild`. */
export function projectFolderName(text) {
  const clean = String(text ?? "")
    .replace(/[/\\\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_LIMIT)
    .trim()
    .replace(/^\.+/, "")
    .trim();
  return validDirectoryName(clean) ? clean : "Rebuild";
}

/** Throws unless `target` is still the directory `made` (same device and inode). */
export async function assertUnchanged(target, made) {
  let now;
  try {
    now = await fs.lstat(target, { bigint: true });
  } catch {
    throw unavailable();
  }
  if (!now.isDirectory() || now.dev !== made.dev || now.ino !== made.ino)
    throw unavailable();
}

// The owner's default folder, canonical, an existing and writable directory.
async function defaultParent(preferences) {
  try {
    const parent = await fs.realpath(preferences.get().defaultCwd);
    if (!(await fs.stat(parent)).isDirectory()) throw Error();
    await fs.access(parent, constants.W_OK);
    return parent;
  } catch {
    throw unavailable();
  }
}

async function makeFolder(parent, name, unique) {
  for (let n = 1; n <= (unique ? SUFFIX_LIMIT : 1); n++) {
    try {
      return (await createDirectory(parent, n === 1 ? name : `${name} ${n}`)).path;
    } catch (error) {
      if (error.status !== 409) throw unavailable();
      if (!unique || n === SUFFIX_LIMIT) throw assistantProblem("projectExists", 409);
    }
  }
}

/**
 * Registers the new folder as a project of its own: never an enclosing repository
 * (the default folder may lie inside one), the home or a collection folder, nor a
 * project AgentPier knew before. A project row that already names this path or folder
 * (an earlier project whose folder was deleted, its inode reused) is refused too:
 * registering would rebind it and its data into the new project
 * (ProjectMemory#followGitInit).
 */
async function registerFolder(memory, target, made) {
  let project;
  try {
    const scope = await projectScope(target);
    if (scope.cwd !== target) throw Error();
    const folder = JSON.stringify([
      "directory",
      target,
      String(made.dev),
      String(made.ino),
    ]);
    if (memory.claimsFolder(target, [folder, scope.identity])) throw Error();
    const known = new Set(memory.projectNames().map((p) => p.id));
    project = await memory.register(target);
    if (!project || project.cwd !== target || known.has(project.id)) throw Error();
  } catch {
    throw unavailable();
  }
  return project;
}

/**
 * The safe creation of a fresh project folder in the owner's default folder: made
 * with a name no folder has (or, with `unique`, the next free ` 2`, ` 3`, …), held
 * open, checked unchanged, optionally `git init`ed and registered as a project of its
 * own. A failure removes what this call made and throws. `rollback` removes the
 * registration and the folder later, never anything put in the folder's place;
 * `release` closes the hold (the caller calls it when its own work is settled, and
 * `rollback` does too). `gitInit` and `unchanged` are replaceable for tests; `label` starts the rollback log lines.
 */
export async function createProjectFolder({
  preferences,
  memory,
  name,
  git = true,
  unique = false,
  gitInit = initRepository,
  unchanged = assertUnchanged,
  label = "Project folder",
}) {
  const parent = await defaultParent(preferences);
  const target = await makeFolder(parent, name, unique);
  // The new folder stays open until released: an open inode is never freed, so no
  // folder put in its place can get its device and inode numbers (Linux file systems
  // hand a freed inode number to the next new folder at once).
  let held, made;
  try {
    held = await fs.open(target, openFolder);
    made = await held.stat({ bigint: true });
  } catch {
    await held?.close().catch(() => {});
    await fs.rmdir(target).catch(() => {});
    throw unavailable();
  }
  let project = null;
  const release = () => held.close().catch(() => {});
  const rollback = async () => {
    try {
      // Fresh (registering refused known and claimed folders), so it holds nothing.
      if (project) memory.removeEmpty(project.id);
    } catch (error) {
      console.error(`${label} rollback failed:`, error?.message);
    }
    await release();
    // Only the folder this call made goes; whatever was put in its place stays.
    let now;
    try {
      now = await fs.lstat(target, { bigint: true });
    } catch {
      return;
    }
    if (!now.isDirectory() || now.dev !== made.dev || now.ino !== made.ino) {
      console.error(`${label} rollback left a replaced folder in place.`);
      return;
    }
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  };
  try {
    // The folder must still be the one this call made, never a link put in its place.
    await unchanged(target, made);
    if (git)
      try {
        await gitInit(target);
      } catch {
        throw unavailable();
      }
    await unchanged(target, made);
    project = await registerFolder(memory, target, made);
  } catch (error) {
    await rollback();
    throw error;
  }
  return { project, path: target, rollback, release };
}
