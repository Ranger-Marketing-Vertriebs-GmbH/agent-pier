import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import {
  createQualificationDiagnostics,
  runQualificationCommand,
} from "../../scripts/verify-assistant-installation.mjs";

test("qualification diagnostics locate startup failure without exposing runtime output", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qualification-diagnostics-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, "gateway-console.log"),
    "private-token private-path\n[plugins] loading private-plugin\nError: EADDRINUSE private-address\n",
  );
  const runtime = Object.assign(new EventEmitter(), {
    paths: { logs: directory },
    spawn,
    status: () => ({ availability: "failed", diagnostic: "UNAVAILABLE" }),
  });
  const records = [];
  const diagnostics = createQualificationDiagnostics(runtime, {
    report: (record) => records.push(record),
  });
  const failure = Object.assign(Error("private-error"), { code: "UNAVAILABLE" });
  try {
    await assert.rejects(
      diagnostics.phase("initial-start", async () => {
        runtime.emit("status", { availability: "starting", diagnostic: null });
        const child = runtime.spawn(process.execPath, ["-e", "process.exit(7)"], {
          stdio: "ignore",
        });
        await once(child, "exit");
        throw failure;
      }),
      (error) => error === failure,
    );
  } finally {
    diagnostics.close();
  }
  assert.equal(runtime.spawn, spawn);
  assert.equal(runtime.listenerCount("status"), 0);
  assert.ok(
    records.some((record) => record.event === "child-exit" && record.exitCode === 7),
  );
  const failed = records.find((record) => record.event === "phase-failed");
  assert.equal(failed.phase, "initial-start");
  assert.equal(failed.errorCode, "UNAVAILABLE");
  assert.equal(failed.availability, "failed");
  assert.ok(Number.isInteger(failed.elapsedMs) && failed.elapsedMs >= 0);
  assert.deepEqual(failed.console.categories, ["plugins", "address-in-use"]);
  assert.equal(JSON.stringify(records).includes("private"), false);
  assert.equal(JSON.stringify(records).includes(directory), false);
});

test("qualification diagnostics bound log reads and redact unknown status and codes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qualification-diagnostics-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "gateway-console.log"), "secret".repeat(20000));
  const runtime = Object.assign(new EventEmitter(), {
    paths: { logs: directory },
    spawn,
    status: () => ({ availability: "secret-status", diagnostic: "SECRET_CODE" }),
  });
  const records = [];
  const diagnostics = createQualificationDiagnostics(runtime, {
    report: (record) => records.push(record),
  });
  try {
    assert.equal(await diagnostics.phase("cached-stage", async () => 42), 42);
    await assert.rejects(
      diagnostics.phase("restart", async () => {
        throw Object.assign(Error("secret"), { code: "SECRET_CODE" });
      }),
    );
  } finally {
    diagnostics.close();
  }
  assert.ok(records.some((record) => record.event === "phase-complete"));
  const failed = records.find((record) => record.event === "phase-failed");
  assert.equal(failed.console.sampledBytes, 65536);
  assert.equal(failed.console.truncated, true);
  assert.equal(failed.errorCode, "OTHER");
  assert.equal(failed.availability, "unknown");
  assert.equal(failed.diagnostic, "OTHER");
  assert.equal(JSON.stringify(records).includes("secret"), false);
  assert.equal(JSON.stringify(records).includes("SECRET_CODE"), false);
});

test("installation qualification reports a failed command without leaking its output", async () => {
  await assert.rejects(
    runQualificationCommand(process.execPath, [
      "-e",
      'console.error("private fixture output"); process.exit(7)',
    ]),
    (error) => error.message.includes("exit 7") && !error.message.includes("private"),
  );
});

test("installation qualification terminates an owned process group on cancellation", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await assert.rejects(
      runQualificationCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        signal: controller.signal,
      }),
      /cancelled/,
    );
  } finally {
    clearTimeout(timer);
  }
});

test("installation qualification bounds command duration and captures successful output", async () => {
  assert.equal(
    await runQualificationCommand(process.execPath, ["-e", 'console.log("fixture")']),
    "fixture\n",
  );
  await assert.rejects(
    runQualificationCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeout: 150,
    }),
    /timed out/,
  );
});

test(
  "installation qualification kills descendants after their launcher exits",
  { timeout: 5000 },
  async () => {
    await assert.rejects(
      runQualificationCommand(
        process.execPath,
        [
          "-e",
          'require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); process.exit(0)',
        ],
        { timeout: 500 },
      ),
      /timed out/,
    );
  },
);
