import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SessionManager } from "../../server/features/sessions/session-manager.js";

/**
 * Test-process safety net: every private tmux server a test process starts is killed when
 * the process exits, even when a test failed before its own teardown ran. Only servers whose
 * data directory lives under the OS temp directory are touched, never real installations.
 *
 * Limits: cleanup runs from this process's exit handling, so a test file killed by a
 * signal or the runner's timeout leaks its servers, and tmux servers started by child
 * server processes (for example a spawned AgentPier) are not tracked here.
 */
const owned = new Map();
const temporaryRoot = fs.realpathSync(os.tmpdir());
const initialize = SessionManager.prototype.initialize;

SessionManager.prototype.initialize = function trackedInitialize(...args) {
  const directory = path.resolve(this.directory);
  if (
    directory.startsWith(`${temporaryRoot}${path.sep}`) ||
    directory.startsWith(`${os.tmpdir()}${path.sep}`)
  )
    owned.set(this.socketPath, this.tmuxPath);
  return initialize.apply(this, args);
};

export function reapTmuxServers() {
  for (const [socketPath, tmuxPath] of owned) {
    spawnSync(tmuxPath, ["-S", socketPath, "kill-server"], {
      stdio: "ignore",
      timeout: 3000,
    });
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
  owned.clear();
}

process.on("exit", reapTmuxServers);
