import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(
  new URL("../../server/terminal-launcher.js", import.meta.url),
);

// Starts the launcher for `sleep 30` as if a tmux server with PID `server` ran it.
function start(t, server) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-launcher-orphan-"));
  const file = path.join(dir, "s.launch.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ command: "/bin/sleep", args: ["30"], cwd: dir, env: {} }),
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [launcher, file], {
    stdio: "ignore",
    env: { ...process.env, TMUX: `/tmp/agentpier-test.sock,${server},0` },
  });
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  t.after(async () => {
    child.kill("SIGTERM");
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return exited;
}

const within = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve("running"), ms).unref()),
  ]);

test("a launcher whose tmux server is gone stops its CLI and exits", async (t) => {
  // The test process is the parent, so any other PID is a server that is gone.
  const outcome = await within(start(t, process.pid + 1), 5000);
  assert.notEqual(outcome, "running");
  assert.equal(outcome.code, 128);
});

test("a launcher under its own tmux server keeps running", async (t) => {
  assert.equal(await within(start(t, process.pid), 1500), "running");
});
