import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSshCommand, sshOutputLimit } from "../../server/features/ssh/ssh-run.js";

// The local Node binary stands in for OpenSSH: `-e <command>` runs the command text,
// so no test reaches a network or a real ~/.ssh.
function connection(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-run-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { command: process.execPath, args: ["-e"], cwd };
}

test("a command runs without a shell and reports its exit", async (t) => {
  const result = await runSshCommand(
    connection(t),
    'process.stdout.write("$(echo x) $HOME"); process.exit(3)',
    { timeoutMs: 5000 },
  );
  assert.equal(result.stdout, "$(echo x) $HOME");
  assert.equal(result.exitCode, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.revoked, false);
  assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0);
});

test("combined output stops at 64 KiB without splitting a character", async (t) => {
  const result = await runSshCommand(
    connection(t),
    'process.stdout.write("é".repeat(40000)); process.stderr.write("tail")',
    { timeoutMs: 5000 },
  );
  assert.equal(result.truncated, true);
  assert.ok(
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= sshOutputLimit,
  );
  assert.equal(result.stdout.includes("�"), false);
  assert.match(result.stdout, /^é+$/);
});

test("a timeout kills the command", async (t) => {
  const result = await runSshCommand(connection(t), "setTimeout(() => {}, 30000)", {
    timeoutMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
});

test("a failed authorization check kills the command within one interval", async (t) => {
  let allowed = true;
  setTimeout(() => {
    allowed = false;
  }, 300);
  const result = await runSshCommand(connection(t), "setTimeout(() => {}, 30000)", {
    timeoutMs: 30000,
    intervalMs: 50,
    stillAuthorized: () => allowed,
  });
  assert.equal(result.revoked, true);
  assert.ok(result.durationMs < 2000);
});

test("a check that throws counts as revoked", async (t) => {
  const result = await runSshCommand(connection(t), "setTimeout(() => {}, 30000)", {
    timeoutMs: 30000,
    intervalMs: 50,
    stillAuthorized: () => {
      throw Error("gone");
    },
  });
  assert.equal(result.revoked, true);
});

test("onSpawn receives the child", async (t) => {
  let pid = null;
  await runSshCommand(connection(t), "process.exit(0)", {
    timeoutMs: 5000,
    onSpawn: (child) => {
      pid = child.pid;
    },
  });
  assert.ok(Number.isInteger(pid));
});

test("a missing program rejects with 502", async (t) => {
  await assert.rejects(
    runSshCommand(
      { ...connection(t), command: path.join(os.tmpdir(), "agentpier-missing-ssh") },
      "true",
      { timeoutMs: 1000 },
    ),
    { status: 502 },
  );
});
