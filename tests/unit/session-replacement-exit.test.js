import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceSession } from "../../server/features/sessions/session-replacement.js";

// A session manager whose tmux is a stub: the pane process is `pane`, a real child
// that exits on its own a little after the stop, as a CLI saving its files would.
function manager(t, pane) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-replace-exit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const session = {
    id: "replace-exit",
    tool: "claude",
    cwd: directory,
    status: "running",
    accountId: "local-claude",
    reload: { state: "reloading" },
  };
  return {
    directory,
    session,
    clients: [],
    pendingTerminalInput: new Map(),
    reconciledStops: new Map(),
    exitWaitMs: 5000,
    save: async () => {},
    metadata: async () => session,
    remember: async () => {},
    killSession: async () => {},
    sessionName: (x) => `agentpier-${x}`,
    target: (x) => `=agentpier-${x}`,
    tmux: async (args) =>
      args[0] === "display-message" ? `${pane?.pid ?? ""}\n` : undefined,
  };
}

test("a replacement prepares the new launch only after the old CLI exited", async (t) => {
  const pane = spawn(process.execPath, ["-e", "setTimeout(() => {}, 400)"]);
  let exited = false;
  pane.on("exit", () => (exited = true));
  t.after(() => pane.kill());
  const m = manager(t, pane);
  let exitedAtPrepare = null;
  await replaceSession(m, m.session.id, async () => {
    exitedAtPrepare = exited;
    return { command: process.execPath, args: [], env: {} };
  });
  assert.equal(exitedAtPrepare, true);
});

test("a pane that never exits delays the replacement only up to its limit", async (t) => {
  const pane = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
  t.after(() => pane.kill());
  const m = manager(t, pane);
  m.exitWaitMs = 200;
  const started = Date.now();
  let prepared = false;
  await replaceSession(m, m.session.id, async () => {
    prepared = true;
    return { command: process.execPath, args: [], env: {} };
  });
  assert.equal(prepared, true);
  assert.ok(Date.now() - started < 3000);
});
