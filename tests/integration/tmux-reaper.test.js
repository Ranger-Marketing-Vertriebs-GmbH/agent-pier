import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const reaper = path.resolve(import.meta.dirname, "../helpers/tmux-reaper.js");
const manager = path.resolve(
  import.meta.dirname,
  "../../server/features/sessions/session-manager.js",
);

test("a test process that skips teardown leaves no tmux server behind", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-reaper-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = `
    import { SessionManager } from ${JSON.stringify(manager)};
    const m = new SessionManager({ dataDir: ${JSON.stringify(root)} });
    await m.ready;
    await m.tmux(["new-session", "-d", "-s", "leak", "sleep 60"]);
    console.log(m.socketPath);
    throw new Error("simulated test failure without teardown");
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", reaper, "--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  const socket = child.stdout.trim();
  assert.match(socket, /\/tmp\/tuiui-.*\/tmux\.sock$/);
  assert.notEqual(child.status, 0);
  await assert.rejects(exec("tmux", ["-S", socket, "list-sessions"]));
  await assert.rejects(fs.stat(path.dirname(socket)));
});
