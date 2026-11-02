// Node-only: the per-CLI behaviour that touches the file system. The catalog next
// to it stays browser-safe.
import { cliDefinition } from "./catalog.js";
import * as codex from "./codex/profile.js";
import * as claude from "./claude/profile.js";
import * as opencode from "./opencode/profile.js";

const profiles = { codex, claude, opencode };
const drivers = new Map();

/**
 * profileEnv(root): variables isolating one account under `root`.
 * configRoot(env, home): where the CLI keeps its config for `env`.
 * dataRoot(env, home): where it keeps its data (history, databases).
 * parseAuthStatus(stdout, exitCode, stderr): { signedIn, state }.
 */
export function cliDriver(id) {
  const definition = cliDefinition(id);
  if (!drivers.has(id)) {
    const profile = profiles[id];
    drivers.set(
      id,
      Object.freeze({
        definition,
        profileEnv: profile.profileEnv,
        configRoot: profile.configRoot,
        dataRoot: profile.dataRoot,
        parseAuthStatus(stdout, exitCode, stderr = "") {
          const state = profile.parseAuthStatus(stdout, stderr, exitCode);
          return { signedIn: state === "authenticated", state };
        },
      }),
    );
  }
  return drivers.get(id);
}
