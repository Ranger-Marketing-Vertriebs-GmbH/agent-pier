import fs from "node:fs";
import path from "node:path";
import { assistantProblem } from "../assistant-validation.js";
import { agentLocalRoot } from "../agent-sftp-local.js";
import { projectTarget } from "../project-paths.js";
import { openInside } from "../project-open.js";
import { fold } from "../team-plugin/tool-guard.js";
import { caseInsensitiveTarget, ensureDirectory } from "../../sftp/sftp-local.js";
import { isSftpProblem } from "../../sftp/sftp-errors.js";
import { partName } from "../../sftp/sftp-excludes.js";
import { fallbackFileType } from "../../mail/mail-file-types.js";
import { numberedName, safeFileName } from "./agent-mail-file-names.js";
import {
  assertOutside,
  protectedDirs,
  sameDir,
  validPath,
} from "./agent-mail-sources.js";

// Where an agent saves a mail attachment (agentpier_mail `attachment` with mode
// `save`), and the write itself. In the workspace only `mail/` or below it (by
// default `mail/<account name>/`), so a mail never creates a file the agent loads as
// an instruction, a skill or a credential (AGENTS.md, SOUL.md, skills/, .agents/,
// attachments/, .agentpier/). A hook run never writes the workspace. In a project
// the folder must be granted with write access, and the reserved paths of SFTP
// transfers apply (agent-sftp-local.js, project-paths.js) with tool configuration
// and instruction files locked for every agent: `.git`, the run worktrees, hooks,
// instruction files, editor and CLI configuration. AgentPier's data directory is
// refused by device and inode, whatever its spelling. No link is followed, and an
// existing file is never replaced: the bytes go to an exclusive temporary file that
// is hard-linked under the first free numbered name (`a.pdf`, `a (2).pdf`, ...);
// on a file system without hard links the file is created exclusively at that name.
// Tool configuration and instruction files (CLAUDE.md, .claude/, ...) are locked in
// the workspace too, by their fixed names: below mail/ they would still load in a
// session started there. The repository scan stays for projects only.

const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
const refused = () => assistantProblem("mailSaveRefused", 403);
const refusals = new Set([
  "sftpWorkspaceRefused",
  "projectPathRefused",
  "projectToolConfigLocked",
]);
const mapped = (error) =>
  refusals.has(error?.key) || isSftpProblem(error) ? refused() : error;
const maxNumber = 999;
// Errors of a file system that cannot hard-link here: the file is written in place.
const noLinks = new Set(["ENOTSUP", "EPERM", "EMLINK", "EXDEV"]);
const isMail = (top) => fold(top ?? "") === "mail";
const realpath = (value) => {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
};

function inWorkspace(w, ctx, requested, accountName) {
  const local = agentLocalRoot(w, ctx, { write: true });
  const raw = requested ?? `mail/${safeFileName(accountName, fallbackFileType)}`;
  // The fixed names only: the repository scan (project-config-lock.js) would refuse
  // every save in a workspace over its folder limit, and mail/ is no repository.
  const folder = projectTarget(local.root, raw, {
    write: true,
    lockToolConfig: true,
    repoConfig: false,
  });
  // `Mail/` is the same folder on a file system that ignores case.
  if (!isMail(folder.relative.split("/")[0])) throw refused();
  return {
    root: folder.root,
    folder,
    workspace: true,
    projectId: null,
    projectName: null,
    protectedRoots: [],
  };
}

function inProject(w, ctx, projectId, requested) {
  // A follow-up without its turn's context saves to its workspace only.
  if (ctx.workspaceOnly) throw refused();
  const local = agentLocalRoot(w, ctx, { projectId, write: true });
  // The data directory is refused before anything below the folder is looked up.
  assertOutside(w, local.root, refused);
  const folder = projectTarget(local.root, requested, {
    write: true,
    protectedRoots: local.protectedRoots,
    lockToolConfig: true,
  });
  return {
    root: folder.root,
    folder,
    workspace: false,
    projectId,
    projectName: local.projectName,
    protectedRoots: local.protectedRoots,
  };
}

/**
 * The folder an attachment is saved to: `{ root, folder, workspace, projectId,
 * projectName, protectedRoots }`, `folder` a projectTarget result below the real
 * `root`. Without `projectId` the workspace's `path` (default `mail/<account>`),
 * which must be `mail` or below it; with `projectId` the folder `path` in that
 * project, which needs write access. A place outside these rules is
 * MAIL_SAVE_REFUSED; a missing grant, a read-only grant or routine and an
 * unavailable write guard keep their own errors. `files` is fileContext's result.
 */
export function saveTarget(w, files, { projectId, path: requested, accountName } = {}) {
  if (requested !== undefined && !validPath(requested)) throw assistantProblem("invalid");
  if (
    projectId !== undefined &&
    (typeof projectId !== "string" || requested === undefined)
  )
    throw assistantProblem("invalid");
  try {
    const target =
      projectId === undefined
        ? inWorkspace(w, files.ctx, requested, accountName)
        : inProject(w, files.ctx, projectId, requested);
    // The data directory's identity, for every folder writeNewFile walks.
    return Object.freeze({ ...target, refuseDirs: Object.freeze(protectedDirs(w)) });
  } catch (error) {
    throw mapped(error);
  }
}

// The folders of the target, created one name at a time below the real root, never
// through or as a link and never AgentPier's data directory. Returns the last one by
// its real path; it may differ from the walked one only in case, and only where the
// file system ignores case.
async function ensureFolder(target, parts) {
  if (!Array.isArray(target.refuseDirs)) throw new TypeError("No save target.");
  let directory = target.root;
  for (const part of parts) {
    directory = path.join(directory, part);
    await ensureDirectory(directory);
    const stat = await fs.promises.lstat(directory, { bigint: true });
    if (sameDir(target.refuseDirs, stat)) throw refused();
  }
  const real = realpath(directory);
  if (real === directory) return directory;
  if (!real || fold(real) !== fold(directory) || !caseInsensitiveTarget({ real }))
    throw refused();
  return real;
}

// Writes the file at `destination` itself, created exclusively without following
// any link; a failed write removes it. False when the name is taken.
async function writeInPlace(destination, bytes) {
  let handle;
  try {
    handle = await openInside(destination, O_WRONLY | O_CREAT | O_EXCL, 0o600);
  } catch (error) {
    if (error.code === "EEXIST") return false;
    if (error.code === "ELOOP") throw refused();
    throw error;
  }
  try {
    await handle.writeFile(bytes);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.rm(destination, { force: true });
    throw error;
  }
  return true;
}

async function exists(file) {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Links the written temporary file under the first free numbered name, or writes
// `bytes` there where the file system has no hard links.
async function linkFree(target, directory, name, file) {
  const parts = path.relative(target.root, directory).split(path.sep).filter(Boolean);
  const rules = {
    write: true,
    protectedRoots: target.protectedRoots,
    lockToolConfig: true,
    repoConfig: !target.workspace,
  };
  for (let n = 1; n <= maxNumber; n++) {
    const candidate = numberedName(name, n);
    const destination = path.join(directory, candidate);
    if (await exists(destination)) continue;
    const relative = [...parts, candidate].join("/");
    // The reserved names (tool configuration, instruction files) for this name.
    projectTarget(target.root, relative, rules);
    if (realpath(directory) !== directory) throw refused();
    try {
      await fs.promises.link(file.temporary, destination);
    } catch (error) {
      if (error.code === "EEXIST") continue;
      if (!noLinks.has(error.code)) throw error;
      if (await writeInPlace(destination, file.bytes)) return { path: relative };
      continue;
    }
    const linked = await fs.promises.lstat(destination, { bigint: true });
    if (linked.dev !== file.identity.dev || linked.ino !== file.identity.ino) {
      await fs.promises.rm(destination, { force: true });
      throw refused();
    }
    return { path: relative };
  }
  throw refused();
}

/**
 * Writes `bytes` as a new file named `name` (a safeFileName) in the saveTarget's
 * folder, never replacing an existing file: the first free numbered name is used.
 * The file is created exclusively, without following any link and without an
 * executable bit (0600). Returns `{ path }`, relative to the target's root (POSIX).
 */
export async function writeNewFile(target, name, bytes) {
  if (typeof name !== "string" || !name || safeFileName(name, fallbackFileType) !== name)
    throw refused();
  if (target.workspace && !isMail(target.folder.relative.split("/")[0])) throw refused();
  const parts = target.folder.relative.split("/").filter(Boolean);
  try {
    const directory = await ensureFolder(target, parts);
    const temporary = path.join(directory, partName(name));
    let handle;
    try {
      handle = await openInside(temporary, O_WRONLY | O_CREAT | O_EXCL, 0o600);
    } catch (error) {
      if (error.code === "ELOOP") throw refused();
      throw error;
    }
    try {
      let identity;
      try {
        await handle.writeFile(bytes);
        identity = await handle.stat({ bigint: true });
      } finally {
        await handle.close();
      }
      return await linkFree(target, directory, name, { temporary, identity, bytes });
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  } catch (error) {
    throw mapped(error);
  }
}
