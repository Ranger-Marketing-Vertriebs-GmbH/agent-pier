// The folders a managed account shares with the CLI's own profile, and what a
// sandboxed session needs to reach them (docs/sandbox.md).
import fs from "node:fs";
import path from "node:path";

/**
 * The folders of a managed account that AgentPier links to the CLI's own profile, so
 * that every account uses the same extensions (cli-profiles/assets.js, linkAssets). A
 * CLI may add folders of its own (`assetDirectories` in its `profile-files.js`).
 */
export const SHARED_FOLDERS = ["skills", "agents", "commands", "plugins"];

/**
 * The targets of an account folder's links into the CLI's own profile: for every name
 * in `names` that is a link below `account` and resolves to the folder of the same
 * name below `native`, `{ name, path }` with the real path, sorted by name.
 *
 * The account folder's own sandbox grant does not cover these targets, so a
 * sandboxed session needs each one granted. A link counts only when it points where
 * AgentPier points it, into the profile of the launch's own home: the session may
 * write its account folder, so a link there must not decide what is granted. A
 * missing link, a dangling one and a target that is not a folder yield nothing.
 */
export function linkedFolderTargets({ account, native, names = SHARED_FOLDERS }) {
  if (!account || !native) return [];
  const targets = [];
  for (const name of [...names].sort())
    try {
      const link = path.join(account, name);
      if (!fs.lstatSync(link).isSymbolicLink()) continue;
      const real = fs.realpathSync(link);
      if (
        real !== fs.realpathSync(path.join(native, name)) ||
        !fs.statSync(real).isDirectory()
      )
        continue;
      targets.push({ name, path: real });
    } catch {
      // A missing or unreadable link is left to the CLI.
    }
  return targets;
}

/** The same targets as read-only sandbox grants, never the profile itself. */
export const linkedFolderGrants = (location) =>
  linkedFolderTargets(location).map((target) => ({ access: "read", path: target.path }));
