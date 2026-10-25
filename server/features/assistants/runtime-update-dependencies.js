import fsp from "node:fs/promises";
import path from "node:path";

/**
 * A rollback keeps the workspaces' installed dependencies, which the snapshot left
 * out (omittedDependencies): they are moved beside the snapshot before the restore
 * and back afterwards, by rename on the same file system. Whatever cannot be moved
 * is deleted with the rest of the live tree, as without this, and logged; the
 * agent then installs it again. Entries are numbered by their manifest position,
 * so a rollback repeated after a crash finds what an earlier attempt moved.
 */
const uid = process.getuid?.();
const valid = (relative) =>
  typeof relative === "string" &&
  relative.startsWith("workspaces/") &&
  path.posix.basename(relative) === "node_modules" &&
  !relative.split("/").some((part) => !part || part === "." || part === "..");
const live = (paths, relative) =>
  path.join(paths.workspaces, ...relative.split("/").slice(1));
const ownFolder = (stat) =>
  !!stat && stat.isDirectory() && (uid === undefined || stat.uid === uid);
function report(relative, error) {
  console.error(
    `Update rollback could not keep ${relative}; it is reinstalled instead:`,
    error?.code || error?.message || "Error",
  );
}

/** Moves the omitted dependencies out of the live workspaces; returns what it holds. */
export async function holdDependencies(paths, directory, omitted = []) {
  const holding = path.join(directory, "dependencies");
  const held = [];
  for (const [index, relative] of omitted.entries()) {
    if (!valid(relative)) continue;
    const kept = path.join(holding, String(index));
    try {
      if (!ownFolder(await fsp.lstat(kept).catch(() => null))) {
        const stat = await fsp.lstat(live(paths, relative)).catch(() => null);
        if (!ownFolder(stat)) continue;
        await fsp.mkdir(holding, { recursive: true, mode: 0o700 });
        await fsp.rename(live(paths, relative), kept);
      }
      held.push({ relative, kept });
    } catch (error) {
      report(relative, error);
    }
  }
  return held;
}

/** Puts held dependencies back into the restored workspaces, then drops the rest. */
export async function returnDependencies(paths, directory, held) {
  for (const { relative, kept } of held) {
    try {
      const parent = await fsp.lstat(path.dirname(live(paths, relative)));
      if (!ownFolder(parent)) throw Object.assign(Error(), { code: "ENOTDIR" });
      // rename() would replace an empty folder; nothing restored may be replaced.
      if (await fsp.lstat(live(paths, relative)).catch(() => null))
        throw Object.assign(Error(), { code: "EEXIST" });
      await fsp.rename(kept, live(paths, relative));
    } catch (error) {
      report(relative, error);
    }
  }
  await fsp.rm(path.join(directory, "dependencies"), { recursive: true, force: true });
}
