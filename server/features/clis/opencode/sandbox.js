// What an OpenCode launch needs before it runs inside a nono sandbox (docs/sandbox.md).
import path from "node:path";
import { bundleGrants } from "../ca-files.js";
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

// The variables npm reads its cache folder from, in either spelling.
const NPM_CACHE_VARIABLES = ["npm_config_cache", "NPM_CONFIG_CACHE"];

/**
 * OpenCode installs what its plugins and custom tools import (`@opencode-ai/plugin`
 * into its config folder at every start, npm plugins into its cache) with a built-in
 * npm, whose cache is `~/.npm`. No sandbox profile but a Node one makes that folder
 * writable, and the install ends with "background dependency install failed … EPERM:
 * operation not permitted, mkdir '~/.npm'".
 *
 * `~/.npm` is not granted: every npm of the user trusts what it finds there. A
 * managed account gets a cache of its own inside its cache folder instead, which the
 * account folder's grant covers. Programs the session starts inherit the variable. A
 * launch that already names a cache keeps it, and a local account has no folder of
 * its own: its cache is the sandbox profile's to grant.
 */
export function npmCacheEnvironment(env = {}) {
  if (!env.XDG_CACHE_HOME || NPM_CACHE_VARIABLES.some((name) => env[name])) return null;
  return { npm_config_cache: path.join(env.XDG_CACHE_HOME, "npm") };
}

// The variables OpenCode's runtime (Bun) reads further CA certificates from.
const CA_VARIABLES = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

/**
 * OpenCode verifies TLS certificates against the roots its runtime carries, not the
 * macOS trust store, so it needs no CA file to reach a public host from a sandbox. A
 * CA of the operator's own reaches it through `NODE_EXTRA_CA_CERTS` or
 * `SSL_CERT_FILE`, which the server passes on to its sessions. That file may lie
 * where the sandbox profile reads nothing ("Ignoring extra certs from …, load failed:
 * Operation not permitted", and every certificate of that CA is refused), so it is
 * granted read-only.
 */
export function trustStoreGrants(env = {}) {
  return bundleGrants(env, CA_VARIABLES);
}

/** The launch with what OpenCode needs inside a nono sandbox. */
export function sandboxLaunch(launch) {
  const grants = [...sharedFolderGrants(launch.env), ...trustStoreGrants(launch.env)];
  const cache = npmCacheEnvironment(launch.env);
  if (!grants.length && !cache) return launch;
  return {
    ...launch,
    ...(cache ? { env: { ...launch.env, ...cache } } : {}),
    ...(grants.length
      ? { sandboxGrants: [...(launch.sandboxGrants || []), ...grants] }
      : {}),
  };
}
