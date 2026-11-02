import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { privateDirectory } from "../../../lib/storage.js";

const FOLDERS = {
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state",
  XDG_CACHE_HOME: "cache",
};

/** Environment that keeps one account's OpenCode state under `root`. */
export function profileEnv(root) {
  const env = {};
  for (const [name, folder] of Object.entries(FOLDERS))
    env[name] = privateDirectory(path.join(root, folder));
  return env;
}

export function configRoot(env, home) {
  return path.join(
    env.XDG_CONFIG_HOME || path.join(env.HOME || home, ".config"),
    "opencode",
  );
}

export function dataRoot(env, home) {
  return path.join(
    env.XDG_DATA_HOME || path.join(env.HOME || home, ".local", "share"),
    "opencode",
  );
}

export function parseAuthStatus(stdout, stderr, exitCode) {
  const output = stripVTControlCharacters(`${stdout || ""}\n${stderr || ""}`);
  if (exitCode !== 0) return "unknown";
  const count = output.match(/^\s*└\s+(\d+) credentials?\s*$/m);
  if (!count) return "unknown";
  return Number(count[1]) > 0 ? "authenticated" : "unauthenticated";
}
