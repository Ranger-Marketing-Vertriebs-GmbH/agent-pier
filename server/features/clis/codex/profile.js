import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { privateDirectory } from "../../../lib/storage.js";

/** Environment that keeps one account's Codex state under `root`. */
export function profileEnv(root) {
  return { CODEX_HOME: privateDirectory(path.join(root, "codex")) };
}

export function configRoot(env, home) {
  return env.CODEX_HOME || path.join(env.HOME || home, ".codex");
}

export const dataRoot = configRoot;

export function parseAuthStatus(stdout, stderr, exitCode) {
  const output = stripVTControlCharacters(`${stdout || ""}\n${stderr || ""}`);
  if (exitCode === 0 && /^Logged in using .+/m.test(output)) return "authenticated";
  if (exitCode === 1 && /^Not logged in\s*$/m.test(output)) return "unauthenticated";
  return "unknown";
}
