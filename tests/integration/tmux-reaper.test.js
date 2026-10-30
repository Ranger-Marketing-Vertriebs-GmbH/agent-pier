import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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
  assert.match(socket, /\/tmp\/agentpier-.*\/tmux\.sock$/);
  assert.notEqual(child.status, 0);
  await assert.rejects(exec("tmux", ["-S", socket, "list-sessions"]));
  await assert.rejects(fs.stat(path.dirname(socket)));
});

test("a later test process stops the servers of one killed before its exit cleanup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-reaper-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { registry } = await import(reaper);
  const script = `
    import { SessionManager } from ${JSON.stringify(manager)};
    const m = new SessionManager({ dataDir: ${JSON.stringify(root)} });
    await m.ready;
    await m.tmux(["new-session", "-d", "-s", "leak", "sleep 60"]);
    console.log(m.socketPath);
    process.kill(process.pid, "SIGKILL");
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", reaper, "--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  const socket = child.stdout.trim();
  assert.equal(child.signal, "SIGKILL");
  t.after(() => spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" }));
  await exec("tmux", ["-S", socket, "list-sessions"]);
  const entry = path.join(
    registry,
    `${createHash("sha256").update(socket).digest("hex")}.json`,
  );
  // A recent entry may belong to a test still running elsewhere.
  spawnSync(process.execPath, ["--import", reaper, "-e", ""]);
  await exec("tmux", ["-S", socket, "list-sessions"]);
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(entry, past, past);
  spawnSync(process.execPath, ["--import", reaper, "-e", ""]);
  await assert.rejects(exec("tmux", ["-S", socket, "list-sessions"]));
  await assert.rejects(fs.stat(entry));
});
