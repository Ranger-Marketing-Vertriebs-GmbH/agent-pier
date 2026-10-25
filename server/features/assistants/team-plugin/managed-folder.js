import fs from "node:fs";
import path from "node:path";

// AgentPier's own files in an agent's workspace (.agentpier/secrets.env, written by
// secrets/agent-secrets.js). Native file tools never change them, in any turn, the
// owner's included (tool-guard.js), and AgentPier's own transfers and shares never
// read or write there (guardedWorkspaceEntry, agent-share-source.js). A shell can
// still reach the folder; the next turn's sync restores the file.
export const managedFolder = ".agentpier";
// Approximates the case-insensitive, normalization-insensitive lookup of APFS:
// "AGENTſ.md" (U+017F) and the Kelvin sign U+212A fold to ASCII here.
export const fold = (name) => name.normalize("NFKC").toUpperCase().toLowerCase();
export const managedRefusal = "Files in .agentpier are managed by AgentPier.";

/** Whether a workspace-relative POSIX path names the folder or a path below it. */
export const managedName = (relative) => fold(relative.split("/")[0]) === managedFolder;

const missing = (error) => error.code === "ENOENT" || error.code === "ENOTDIR";

// Where a path leads on disk, existing or not: a missing name below its resolved
// parent, a dangling link where it points (a write through it creates its target).
// Every step counts against the limit, parent steps included, so a deep path or a
// long chain is refused as unresolvable (fail closed), never let through.
function resolved(file, hops) {
  if (++hops.count > 40) throw Object.assign(Error("Too many links"), { code: "ELOOP" });
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  let link = null;
  try {
    link = fs.readlinkSync(file);
  } catch (error) {
    if (!missing(error) && error.code !== "EINVAL") throw error;
  }
  return link === null
    ? path.join(resolved(path.dirname(file), hops), path.basename(file))
    : resolved(path.resolve(path.dirname(file), link), hops);
}

/**
 * Whether a write to `target` (workspace-relative) would land in the managed folder
 * of `workspace` (a real path): through a link to the folder or into it, or as a
 * hard link of a file in it. Throws when the target cannot be resolved.
 */
export function reachesManaged(workspace, target) {
  let folder;
  try {
    folder = fs.realpathSync(path.join(workspace, managedFolder));
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  const relative = path.relative(
    folder,
    resolved(path.join(workspace, target), { count: 0 }),
  );
  if (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
    return true;
  let stat;
  try {
    stat = fs.statSync(path.join(workspace, target));
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  return linked(folder, stat);
}

// Whether a file anywhere below `folder` is the file `stat` describes. The folder
// holds AgentPier's few files, so the walk is cheap; links in it are not followed.
function linked(folder, stat) {
  return fs.readdirSync(folder, { withFileTypes: true }).some((entry) => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return linked(file, stat);
    if (!entry.isFile()) return false;
    try {
      const own = fs.statSync(file);
      return own.dev === stat.dev && own.ino === stat.ino;
    } catch {
      return false;
    }
  });
}
