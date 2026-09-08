import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Doctor } from "../../server/features/operations/doctor.js";
for (const platform of ["darwin", "linux", "win32"])
  test(`doctor reports ${platform} without starting a native session`, async (t) => {
    const dataDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-doctor-")),
    );
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const calls = [];
    const doctor = new Doctor({
      dataDir,
      platform,
      command: async (cmd, args) => {
        calls.push([cmd, args]);
        return { code: 0, stdout: "fixture 1.2.3" };
      },
      ptyCheck: async () => true,
    });
    const report = await doctor.run({ scope: "host" });
    assert.equal(
      report.checks.find((c) => c.id === "platform").status,
      platform === "win32" ? "fail" : "ok",
    );
    assert.ok(calls.every(([, args]) => args[0] === "--version" || args[0] === "-V"));
    assert.equal(report.checks.find((c) => c.id === "cli.codex").status, "ok");
    assert.deepEqual(await fs.readdir(dataDir), []);
  });
