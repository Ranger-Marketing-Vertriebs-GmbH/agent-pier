import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Doctor } from "../../server/features/operations/doctor.js";
import { adapterCheck } from "../../server/features/operations/adapter-doctor.js";
import * as de from "../../web/lib/i18n/de/operations.js";
import * as en from "../../web/lib/i18n/en/operations.js";

const run = async (t, { platform = "darwin", code = 0, pty = true, projects = [] }) => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-doctor-remedy-")),
  );
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.chmod(dataDir, 0o700);
  if (projects.length)
    await fs.writeFile(
      path.join(dataDir, "repositories.json"),
      JSON.stringify({
        projects: projects.map((name) => ({ id: name, path: path.join(dataDir, name) })),
      }),
    );
  await Promise.all(
    projects
      .filter((name) => name.startsWith("present"))
      .map((name) => fs.mkdir(path.join(dataDir, name))),
  );
  const doctor = new Doctor({
    dataDir,
    platform,
    command: async () => ({ code, stdout: code ? "" : "fixture 1.2.3" }),
    ptyCheck: async () => {
      if (!pty) throw Error("missing");
    },
  });
  const report = await doctor.run({ scope: "host" });
  return Object.fromEntries(report.checks.map((check) => [check.id, check]));
};

test("passing and skipped doctor checks carry no remedy", async (t) => {
  const checks = await run(t, { projects: ["present"] });
  for (const id of ["platform", "pty", "tmux", "git", "cli.codex", "project.present"]) {
    assert.equal(checks[id].status, "ok", id);
    assert.equal(checks[id].remedy, undefined, id);
    assert.equal(checks[id].remedyId, undefined, id);
  }
  for (const check of Object.values(checks))
    if (!["warn", "fail"].includes(check.status)) assert.equal(check.remedy, undefined);
});

test("failing doctor checks carry an English remedy and a stable remedy id", async (t) => {
  const checks = await run(t, {
    platform: "win32",
    code: 1,
    pty: false,
    projects: ["missing"],
  });
  const expected = {
    platform: ["fail", "platform"],
    pty: ["fail", "pty"],
    tmux: ["fail", "tool"],
    "cli.codex": ["warn", "tool"],
    "project.missing": ["fail", "project"],
  };
  for (const [id, [status, remedyId]] of Object.entries(expected)) {
    assert.equal(checks[id].status, status, id);
    assert.equal(checks[id].remedyId, remedyId, id);
    assert.equal(typeof checks[id].remedy, "string", id);
  }
  assert.equal(checks.platform.remedy, "Use a supported macOS or Linux host.");
});

test("adapter failures carry stable remedy ids", () => {
  const session = { id: "s1", name: "N", tool: "codex" };
  const gaveUp = adapterCheck(session, {
    supervisor: { restarts: 3, gaveUpAt: "2026-10-08T10:00:00.000Z" },
  });
  assert.equal(gaveUp.remedyId, "adapterReload");
  const failed = adapterCheck(session, {
    supervisor: { startFailed: "timeout", at: "2026-10-08T10:00:00.000Z" },
  });
  assert.equal(failed.remedyId, "adapterRestartFailed");
});

test("every remedy id is translated in German and English", () => {
  const ids = [
    "platform",
    "pty",
    "tool",
    "project",
    "adapterReload",
    "adapterRestartFailed",
  ];
  for (const catalog of [de.diagnosticCopy, en.diagnosticCopy])
    for (const id of ids) assert.equal(typeof catalog.remedies[id], "string", id);
  assert.deepEqual(
    Object.keys(de.diagnosticCopy.remedies).sort(),
    Object.keys(en.diagnosticCopy.remedies).sort(),
  );
});
