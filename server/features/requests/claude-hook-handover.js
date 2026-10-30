import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Claude runs every hook through the private dispatcher (claude-runtime.js), which
// the server points at its own release when it starts. A hook that already waits
// for a decision keeps the code it started with, for up to a day: across an update
// it would still apply an old release's rules. When the broker it reconnects to
// names another hook file, the waiting hook hands its request to the current one:
// it starts the dispatcher with the same hook payload, and the successor joins the
// broker under the same epoch and key, so the request keeps its card and audit.

/** The file this hook runs from; the broker names its own the same way. */
export const hookScript = fileURLToPath(new URL("./claude-hook.js", import.meta.url));
const handoverVariable = "AGENTPIER_CLAUDE_HOOK_HANDOVER";
// An update during a handover hands over again, but never in a loop.
const maxHops = 3;

const real = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

/** Whether the broker's current hook differs from the file this hook runs. */
export function outdated(current, script, inherited) {
  return (
    typeof current === "string" &&
    path.isAbsolute(current) &&
    (inherited?.hops ?? 0) < maxHops &&
    real(current) !== real(script)
  );
}

/** What a predecessor passed on: its request key, epoch and deadline. */
export function handoverState(env) {
  const value = env[handoverVariable];
  if (!value) return null;
  try {
    const state = JSON.parse(value);
    if (
      typeof state.key === "string" &&
      state.key.length <= 100 &&
      typeof state.epoch === "string" &&
      state.epoch.length <= 100 &&
      Number.isFinite(state.deadline) &&
      Number.isSafeInteger(state.hops)
    )
      return state;
  } catch {
    /* A malformed handover starts a request of its own. */
  }
  return null;
}

/**
 * Starts the current hook through the dispatcher beside the launch file, feeding it
 * the payload Claude sent. Its answer goes to `output` (Claude's end of this hook).
 * Resolves when it exits; a dispatcher that cannot start leaves Claude's dialog.
 */
export function handOver({ env, text, output, state }) {
  const dispatcher = path.join(
    path.dirname(env.AGENTPIER_REQUEST_FILE),
    "claude-hook.sh",
  );
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("/bin/sh", [dispatcher], {
        env: { ...env, [handoverVariable]: JSON.stringify(state) },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return resolve();
    }
    child.on("error", () => resolve());
    child.stdout.on("data", (chunk) => output.write(chunk));
    child.on("close", () => resolve());
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}
