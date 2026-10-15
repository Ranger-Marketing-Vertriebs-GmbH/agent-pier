import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcessTree } from "../../server/features/mcp-packages/child-process-tree.js";

const env = { PATH: "/usr/bin:/bin" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Waits up to two seconds: a killed child is reaped by init shortly after. */
async function gone(pid) {
  for (let i = 0; i < 100 && alive(pid); i++) await pause(20);
  return !alive(pid);
}
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-tree-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function pidFrom(file) {
  for (;;) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
    if (/^\d+$/.test(text)) return Number(text);
    await pause(20);
  }
}

test("a run resolves with its output like execFile", async () => {
  const result = await runProcessTree("/bin/sh", ["-c", "echo out; echo err >&2"], {
    env,
  });
  assert.deepEqual(result, { stdout: "out\n", stderr: "err\n" });
});

test("a failing run rejects with its exit code and output", async () => {
  await assert.rejects(
    runProcessTree("/bin/sh", ["-c", "echo partial; exit 3"], { env }),
    (error) => {
      assert.equal(error.code, 3);
      assert.equal(error.stdout, "partial\n");
      assert.equal(error.killed, false);
      return true;
    },
  );
});

test("an aborted run ends the whole process group and rejects as cancelled", async (t) => {
  const pidFile = path.join(scratch(t), "pid");
  const controller = new AbortController();
  const run = runProcessTree(
    "/bin/sh",
    ["-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidFile],
    { env, signal: controller.signal },
  );
  const grandchild = await pidFrom(pidFile);
  controller.abort();
  await assert.rejects(run, { code: "MCP_PACKAGE_CANCELLED" });
  assert.equal(await gone(grandchild), true);
});

test("an already aborted signal starts nothing", async (t) => {
  const marker = path.join(scratch(t), "ran");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runProcessTree("/bin/sh", ["-c", 'touch "$1"', "sh", marker], {
      env,
      signal: controller.signal,
    }),
    { code: "MCP_PACKAGE_CANCELLED" },
  );
  await pause(100);
  assert.equal(fs.existsSync(marker), false);
});

test("a timeout ends the group and rejects as killed", async (t) => {
  const pidFile = path.join(scratch(t), "pid");
  const run = runProcessTree(
    "/bin/sh",
    ["-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidFile],
    { env, timeout: 300 },
  );
  const grandchild = await pidFrom(pidFile);
  await assert.rejects(run, (error) => error.killed === true);
  assert.equal(await gone(grandchild), true);
});

test("output beyond maxBuffer stops the run", async () => {
  await assert.rejects(
    runProcessTree("/bin/sh", ["-c", "yes | head -c 100000; sleep 30"], {
      env,
      maxBuffer: 1000,
    }),
    (error) => error.killed === true,
  );
});

test("a finished run signals no process group", async (t) => {
  const kills = t.mock.method(process, "kill");
  await runProcessTree("/bin/sh", ["-c", "true"], { env });
  assert.equal(kills.mock.calls.filter((call) => call.arguments[0] < 0).length, 0);
});

test("a character split across output chunks stays intact", async () => {
  const result = await runProcessTree(
    "/bin/sh",
    ["-c", "printf '\\342\\234'; sleep 0.2; printf '\\223\\n'"],
    { env },
  );
  assert.equal(result.stdout, "✓\n");
});

test("a run that never started signals no process group on abort", async (t) => {
  const kills = t.mock.method(process, "kill");
  const controller = new AbortController();
  const run = runProcessTree("/nonexistent/agentpier-tool", [], {
    env,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(run);
  assert.equal(kills.mock.calls.length, 0);
});
