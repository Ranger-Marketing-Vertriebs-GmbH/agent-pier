import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  importOpenClawExports,
  locateOpenClawExports,
} from "../helpers/openclaw-dist-exports.js";

function fakePackage(t, version, modules) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dist-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  for (const [file, source] of Object.entries(modules))
    fs.writeFileSync(path.join(root, "dist", file), source);
  return root;
}

const scheduling = (alias) =>
  `function computeJobNextRunAtMs() { return 1; }\nconst other = 2;\n` +
  `export { other as a, computeJobNextRunAtMs as ${alias} };\n`;

test("symbols resolve by their original export name, whatever the chunk hash", async (t) => {
  for (const [file, alias] of [
    ["jobs-scheduling-BFO_sCWD.mjs", "n"],
    ["jobs-scheduling-Zx81Qa_c.mjs", "q"],
  ]) {
    const root = fakePackage(t, "2026.9.8", {
      [file]: scheduling(alias),
      "service-m6MonO39.mjs": "class CronService {}\nexport { CronService as t };\n",
      "unrelated.js": "export const value = 1;\n",
    });
    const { computeJobNextRunAtMs, CronService } = await importOpenClawExports(root, [
      "computeJobNextRunAtMs",
      "CronService",
    ]);
    assert.equal(computeJobNextRunAtMs(), 1);
    assert.equal(typeof CronService, "function");
  }
});

test("a missing or ambiguous symbol fails with the OpenClaw version", async (t) => {
  const missing = fakePackage(t, "2026.10.1", {
    "jobs-scheduling-abc.mjs": scheduling("n"),
  });
  await assert.rejects(importOpenClawExports(missing, ["CronService"]), {
    message: /OpenClaw 2026\.10\.1.*CronService/,
  });
  const ambiguous = fakePackage(t, "2026.10.2", {
    "one-abc.mjs": scheduling("n"),
    "two-def.mjs": scheduling("m"),
  });
  await assert.rejects(importOpenClawExports(ambiguous, ["computeJobNextRunAtMs"]), {
    message: /OpenClaw 2026\.10\.2.*computeJobNextRunAtMs.*one-abc\.mjs.*two-def\.mjs/,
  });
});

test("located symbols name the defining chunk, not barrels re-exporting it", (t) => {
  const root = fakePackage(t, "2026.9.8", {
    "auth-profiles-E6czwkgH.mjs":
      'import { s as computeJobNextRunAtMs } from "./profiles-CssUDvXQ.mjs";\n' +
      "export { computeJobNextRunAtMs };\n",
    "profiles-CssUDvXQ.mjs": scheduling("s"),
  });
  const { computeJobNextRunAtMs } = locateOpenClawExports(root, [
    "computeJobNextRunAtMs",
  ]);
  assert.deepEqual(computeJobNextRunAtMs, {
    path: path.join(root, "dist", "profiles-CssUDvXQ.mjs"),
    alias: "s",
  });
});
