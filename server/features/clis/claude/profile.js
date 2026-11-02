import path from "node:path";
import { privateDirectory } from "../../../lib/storage.js";

/** Environment that keeps one account's Claude Code state under `root`. */
export function profileEnv(root) {
  const dir = privateDirectory(path.join(root, "claude"));
  return { CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir };
}

export function configRoot(env, home) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || home, ".claude");
}

export function parseAuthStatus(stdout) {
  const status = JSON.parse(stdout);
  if (status.loggedIn === true) return "authenticated";
  if (status.loggedIn === false) return "unauthenticated";
  return "unknown";
}
