import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { SessionManager } from "../../server/features/sessions/session-manager.js";

/**
 * Test-process safety net: every private tmux server a test process starts is killed when
 * the process exits, even when a test failed before its own teardown ran. Only servers whose
 * data directory lives under the OS temp directory are touched, never real installations.
 *
 * A test file killed by a signal or a timeout cannot clean up on exit, so each server is
 * also recorded in a per-user registry; the next test process that loads this module
 * stops recorded servers older than an hour. tmux servers started by child server
 * processes (for example a spawned AgentPier) are not tracked here.
 */
const owned = new Map();
const temporaryRoot = fs.realpathSync(os.tmpdir());
const initialize = SessionManager.prototype.initialize;
// Fixed, not os.tmpdir(): the test runner gives each run its own TMPDIR.
export const registry = path.join("/tmp", `agentpier-test-tmux-${process.getuid()}`);
export const staleAfterMs = 60 * 60 * 1000;
const entryFor = (socketPath) =>
  path.join(registry, `${createHash("sha256").update(socketPath).digest("hex")}.json`);

function ownRegistry() {
  try {
    fs.mkdirSync(registry, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") return false;
  }
  const stat = fs.lstatSync(registry);
  return stat.isDirectory() && stat.uid === process.getuid();
}

function stopServer(socketPath, tmuxPath) {
  spawnSync(tmuxPath, ["-S", socketPath, "kill-server"], {
    stdio: "ignore",
    timeout: 3000,
  });
  fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  fs.rmSync(entryFor(socketPath), { force: true });
}

SessionManager.prototype.initialize = function trackedInitialize(...args) {
  const directory = path.resolve(this.directory);
  if (
    directory.startsWith(`${temporaryRoot}${path.sep}`) ||
    directory.startsWith(`${os.tmpdir()}${path.sep}`)
  )
    // A manager on the legacy socket moves to the produced one once it drains.
    for (const socketPath of new Set([this.socketPath, this.tmuxSockets?.produced]))
      if (socketPath) {
        owned.set(socketPath, this.tmuxPath);
        try {
          if (ownRegistry())
            fs.writeFileSync(
              entryFor(socketPath),
              JSON.stringify({ socketPath, tmuxPath: this.tmuxPath }),
              { mode: 0o600 },
            );
        } catch {
          /* The exit handler still covers this process. */
        }
      }
  return initialize.apply(this, args);
};

export function reapTmuxServers() {
  for (const [socketPath, tmuxPath] of owned) stopServer(socketPath, tmuxPath);
  owned.clear();
}

/** Stops the servers earlier test processes recorded and never cleaned up. */
export function reapStaleTmuxServers({ now = Date.now() } = {}) {
  let names;
  try {
    if (!ownRegistry()) return;
    names = fs.readdirSync(registry);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(registry, name);
    try {
      if (now - fs.statSync(file).mtimeMs < staleAfterMs) continue;
      const { socketPath, tmuxPath } = JSON.parse(fs.readFileSync(file, "utf8"));
      // Only a test server's private socket, never the default tmux server.
      if (
        typeof socketPath !== "string" ||
        !/^\/tmp\/agentpier-[^/]+\/tmux\.sock$/.test(socketPath) ||
        typeof tmuxPath !== "string" ||
        path.basename(tmuxPath) !== "tmux" ||
        entryFor(socketPath) !== file
      )
        fs.rmSync(file, { force: true });
      else stopServer(socketPath, tmuxPath);
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
}

reapStaleTmuxServers();
process.on("exit", reapTmuxServers);
