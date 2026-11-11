// What an OpenCode launch needs before it runs inside a nono sandbox (docs/sandbox.md).
import path from "node:path";
import { SHARED_FOLDERS, linkedFolderGrants } from "../linked-folders.js";
import { assetDirectories } from "./profile-files.js";

/**
 * A managed account's `skills`, `agents`, `commands`, `plugins` and `plugin` are
 * links into the CLI's own profile (`~/.config/opencode`), which the account folder's
 * grant does not cover. OpenCode starts without them and loads none of the shared
 * skills, agents, commands and plugins.
 *
 * Granted are the link targets, read-only, never the profile itself (its config
 * files) and nothing of OpenCode's data folder (login, sessions).
 */
export function sharedFolderGrants(env = {}) {
  if (!env.XDG_CONFIG_HOME || !env.HOME) return [];
  return linkedFolderGrants({
    account: path.join(env.XDG_CONFIG_HOME, "opencode"),
    native: path.join(env.HOME, ".config", "opencode"),
    names: [...SHARED_FOLDERS, ...assetDirectories],
  });
}

/** The launch with what OpenCode needs inside a nono sandbox. */
export function sandboxLaunch(launch) {
  const grants = sharedFolderGrants(launch.env);
  if (!grants.length) return launch;
  return { ...launch, sandboxGrants: [...(launch.sandboxGrants || []), ...grants] };
}
