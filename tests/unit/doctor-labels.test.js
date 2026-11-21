// Diagnostics (W8 B2, B3): checks name their subject and carry translatable summaries;
// the project scope uses the memory projects the Projects page lists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Doctor } from "../../server/features/operations/doctor.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import {
  checkLabel,
  summaryText,
} from "../../web/features/operations/diagnostic-labels.js";
import { setLanguage, getLanguage } from "../../web/lib/i18n/index.js";
import * as de from "../../web/lib/i18n/de/operations.js";
import * as en from "../../web/lib/i18n/en/operations.js";

const tempDir = async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-l-")));
  await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
const doctorFor = (dataDir, options = {}) =>
  new Doctor({
    dataDir,
    platform: "darwin",
    command: async () => ({ code: 0, stdout: "fixture 1.2.3" }),
    ptyCheck: async () => {},
    ...options,
  });
const byId = (report) => Object.fromEntries(report.checks.map((c) => [c.id, c]));

test("a provider connection check is headed by its name, not its id", async (t) => {
  const dataDir = await tempDir(t);
  const id = "3b1e2f4a-0000-4000-8000-000000000001";
  await fs.writeFile(
    path.join(dataDir, "provider-connections.json"),
    JSON.stringify([{ id, name: "OpenRouter privat", providerId: "openrouter" }]),
  );
  const check = byId(await doctorFor(dataDir).run())[`provider-connection.${id}`];
  assert.equal(check.subject, "OpenRouter privat");
  assert.equal(check.summaryId, "keyPresence");
  const previous = getLanguage();
  t.after(() => setLanguage(previous));
  setLanguage("en");
  assert.equal(checkLabel(check), "Model access: OpenRouter privat");
  assert.match(summaryText(check), /whether it works was not tested/);
  setLanguage("de");
  assert.equal(checkLabel(check), "Modell-Zugang: OpenRouter privat");
  assert.match(summaryText(check), /nicht getestet/);
  // Without a name the id stays, as before.
  assert.equal(checkLabel({ id: `provider-connection.${id}` }), `Modell-Zugang: ${id}`);
});

test("every summary the doctor sends is translated in both languages", async (t) => {
  const dataDir = await tempDir(t);
  const report = await doctorFor(dataDir).run();
  for (const check of report.checks.filter((c) => c.summaryId))
    for (const catalog of [de.diagnosticCopy, en.diagnosticCopy])
      assert.ok(catalog.summaries[check.summaryId], check.summaryId);
  assert.deepEqual(
    Object.keys(de.diagnosticCopy.summaries).sort(),
    Object.keys(en.diagnosticCopy.summaries).sort(),
  );
  // A check without an id keeps the server's English.
  assert.equal(summaryText({ summary: "Raw." }), "Raw.");
  const previous = getLanguage();
  t.after(() => setLanguage(previous));
  setLanguage("en");
  assert.equal(
    summaryText({ summaryId: "toolVersion", summaryArgs: ["1.2.3"] }),
    "Version 1.2.3 found.",
  );
});

test("the project scope checks the memory projects (CLI reads memory.sqlite)", async (t) => {
  const dataDir = await tempDir(t);
  const folder = path.join(dataDir, "checkout");
  await fs.mkdir(folder);
  const memory = new ProjectMemory({ dataDir });
  t.after(() => memory.close());
  const project = await memory.register(folder);
  // A repositories.json entry is no project of the Projects page.
  await fs.writeFile(
    path.join(dataDir, "repositories.json"),
    JSON.stringify({ projects: [{ id: "repo-only", name: "Repo", path: folder }] }),
  );
  const checks = byId(
    await doctorFor(dataDir).run({ scope: "project", projectId: project.id }),
  );
  assert.equal(checks[`project.${project.id}`].status, "ok");
  assert.equal(checks[`project.${project.id}`].subject, path.basename(folder));
  await assert.rejects(
    doctorFor(dataDir).run({ scope: "project", projectId: "repo-only" }),
    { status: 404 },
  );
  // The running service passes its own list.
  const injected = doctorFor(dataDir, {
    projects: () => [{ id: "p1", name: "Injected", cwd: folder }],
  });
  const host = byId(await injected.run());
  assert.equal(host["project.p1"].subject, "Injected");
});
