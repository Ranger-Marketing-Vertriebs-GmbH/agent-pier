import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

const tmuxPath = process.env.TMUX_PATH || "tmux";
const tmux = (socket, args) => {
  const result = spawnSync(tmuxPath, ["-S", socket, "-f", "/dev/null", ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a launcher that starts after its pane hung up still exits", async (t) => {
  // A test or a server that ends right after new-session can hang up the pane and
  // remove the launch payload before the launcher runs. Its error report must not
  // reopen the hung-up terminal: on macOS that open waits for a carrier forever.
  // Under /tmp: a socket path in a long temp folder exceeds the socket name limit.
  const dir = fs.mkdtempSync("/tmp/agentpier-launcher-hup-");
  const socket = path.join(dir, "tmux.sock");
  const go = path.join(dir, "go");
  let pid = 0;
  t.after(() => {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    spawnSync(tmuxPath, ["-S", socket, "kill-server"], { stdio: "ignore" });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // The shell outlives the hangup, then becomes the launcher for a payload that is gone.
  const script = [
    "trap '' HUP",
    `while [ ! -e '${go}' ]; do sleep 0.05; done`,
    `exec '${process.execPath}' '${launcher}' '${path.join(dir, "gone.launch.json")}'`,
  ].join("; ");
  tmux(socket, ["new-session", "-d", "-s", "hup", "-x", "80", "-y", "24", script]);
  pid = Number(tmux(socket, ["display-message", "-p", "-t", "=hup:0.0", "#{pane_pid}"]));
  assert.ok(pid > 0);
  tmux(socket, ["kill-server"]);
  fs.writeFileSync(go, "");
  const until = Date.now() + 5000;
  while (alive(pid) && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(pid), false, "the launcher is still running");
});
