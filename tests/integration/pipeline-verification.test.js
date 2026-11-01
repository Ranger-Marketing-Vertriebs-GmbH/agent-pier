import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VerificationRunner } from "../../server/features/pipelines/verify-runner.js";
// Per-test hang guard: the runner reports "unavailable" itself when its worker dies.
const guard = { timeout: 60000 };
async function wait(runner, job) {
  for (;;) {
    const r = await runner.inspect(job);
    if (r.status !== "running") return r;
    await new Promise((r) => setTimeout(r, 25));
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
test(
  "verification preserves every step result, scopes timeout to full compound command, and survives runner replacement",
  guard,
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-verify-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const runner = new VerificationRunner({ directory: dir });
    const job = await runner.start({
      cwd: dir,
      steps: [
        {
          name: "first",
          command: "printf first; exit 2",
          timeoutMs: 1000,
          blocking: true,
        },
        { name: "second", command: "printf second", timeoutMs: 1000, blocking: false },
      ],
    });
    await runner.close();
    const replacement = new VerificationRunner({ directory: dir });
    const result = await wait(replacement, job);
    assert.equal(result.status, "fail");
    assert.deepEqual(
      result.steps.map((s) => s.exitCode),
      [2, 0],
    );
    assert.match(result.steps[1].logTail, /second/);
    const hung = await replacement.start({
      cwd: dir,
      steps: [
        { name: "compound", command: "true; sleep 30", timeoutMs: 100, blocking: true },
      ],
    });
    const timed = await wait(replacement, hung);
    assert.equal(timed.status, "timed-out");
    assert.equal(timed.steps[0].timedOut, true);
  },
);
test(
  "verification cancellation signals only its supervised child group and records cancellation",
  guard,
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-verify-cancel-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const runner = new VerificationRunner({ directory: dir });
    const job = await runner.start({
      cwd: dir,
      steps: [
        {
          name: "wait",
          command: "printf ready > cancel-ready; sleep 30",
          timeoutMs: 60000,
          blocking: true,
        },
      ],
    });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, "cancel-ready")); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(fs.existsSync(path.join(dir, "cancel-ready")), true);
    await runner.cancel(job);
    assert.equal((await wait(runner, job)).status, "unavailable");
  },
);

test(
  "a timeout cannot pass a blocking check even when the interrupted shell exits zero",
  guard,
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-verify-zero-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const runner = new VerificationRunner({ directory: dir });
    const job = await runner.start({
      cwd: dir,
      steps: [
        {
          name: "orphan output",
          command: 'trap \"exit 0\" TERM; sleep 30',
          timeoutMs: 100,
          blocking: true,
        },
      ],
    });
    const result = await wait(runner, job);
    assert.notEqual(result.status, "pass");
    assert.equal(result.steps[0].timedOut, true);
  },
);

async function descendantRemoved(t, exitDelay) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-verify-descendant-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runner = new VerificationRunner({ directory: dir });
  const script = path.join(dir, "background.cjs");
  fs.writeFileSync(
    script,
    "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('ready',String(process.pid));setTimeout(()=>process.exit(0),30000);",
  );
  const command = `'${process.execPath}' '${script}' >/dev/null 2>&1 & while [ ! -s ready ]; do sleep 0.02; done; sleep ${exitDelay}; exit 0`;
  const job = await runner.start({
    cwd: dir,
    steps: [{ name: "background", command, timeoutMs: 20000, blocking: true }],
  });
  await wait(runner, job);
  const pid = Number(fs.readFileSync(path.join(dir, "ready"), "utf8"));
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  });
  // The descendant lives for 30s unless the runner removes it, so the outcome does not
  // depend on how late the shell exits relative to the runner's TERM-to-KILL grace.
  for (let i = 0; i < 200 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(alive(pid), false);
}
test(
  "a TERM-ignoring background descendant with redirected output is removed before completion",
  guard,
  (t) => descendantRemoved(t, 0),
);
test(
  "a TERM-ignoring background descendant is removed even when the shell exits late",
  guard,
  (t) => descendantRemoved(t, 1.5),
);

test(
  "verification log tails report truncation without changing the check outcome",
  guard,
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-verify-log-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const runner = new VerificationRunner({ directory: dir });
    const job = await runner.start({
      cwd: dir,
      steps: [
        {
          name: "large log",
          command: "awk 'BEGIN { for (i=0;i<9000;i++) printf \"x\" }'",
          timeoutMs: 2000,
          blocking: true,
        },
      ],
    });
    const result = await wait(runner, job);
    assert.equal(result.status, "pass");
    assert.equal(result.steps[0].logTail.length, 8192);
    assert.equal(result.steps[0].logTruncated, true);
    const { verificationLog } =
      await import("../../server/features/pipelines/artifact-reader.js");
    assert.equal(
      verificationLog(
        null,
        { nodes: [{ id: "stage", verifyResult: result }] },
        "stage",
        0,
      ).truncated,
      true,
    );
  },
);
