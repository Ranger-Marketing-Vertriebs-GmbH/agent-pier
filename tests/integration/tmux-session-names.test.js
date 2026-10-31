import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import { tmuxSocketPath } from "../../server/features/sessions/tmux-naming.js";
import { sessionPanes } from "../../server/features/system-status/system-status.js";

const exec = promisify(execFile);
const tmuxPath = process.env.TMUX_PATH || "tmux";

const names = async (socket) =>
  (
    await exec(tmuxPath, ["-S", socket, "list-sessions", "-F", "#{session_name}"]).catch(
      () => ({ stdout: "" }),
    )
  ).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();

const shell = (extra) => ({
  name: "Fixture",
  tool: "codex",
  accountId: "fixture-account",
  command: "/bin/sh",
  args: ["-c", "echo READY; sleep 60"],
  env: { PATH: "/usr/bin:/bin" },
  ...extra,
});

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-tmux-names-"));
  const socket = tmuxSocketPath(dataDir);
  const manager = new SessionManager({ dataDir, tmuxPath });
  t.after(async () => {
    await manager.close().catch(() => {});
    await exec(tmuxPath, ["-S", socket, "kill-server"]).catch(() => {});
    await rm(path.dirname(socket), { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  await manager.ready;
  return { dataDir, socket, manager };
}

test("new sessions get the agentpier name on the agentpier socket", async (t) => {
  const { dataDir, socket, manager } = await fixture(t);
  assert.equal(manager.socketPath, socket);
  const created = await manager.create(shell({ id: "new-one", cwd: dataDir }));
  assert.equal(manager.target(created.id), `=agentpier-${created.id}`);
  assert.deepEqual(await names(socket), [`agentpier-${created.id}`]);
});

test("a tmux session under any other name is neither counted nor ended", async (t) => {
  const { dataDir, socket, manager } = await fixture(t);
  const created = await manager.create(shell({ id: "ours", cwd: dataDir }));
  // For example a session an installation from before the rename left on this socket.
  await manager.tmux(["new-session", "-d", "-s", "legacy-ours", "sleep 60"]);
  assert.deepEqual(
    (await sessionPanes(manager)).map((pane) => pane.id),
    [created.id],
  );
  await manager.stop(created.id);
  await manager.remove(created.id);
  assert.deepEqual(await names(socket), ["legacy-ours"]);
});
