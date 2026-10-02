import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = new URL("../../scripts/mutation-summary.mjs", import.meta.url);
function summarize(t, report) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-mutation-report-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "mutation.json");
  if (report !== undefined) fs.writeFileSync(file, JSON.stringify(report));
  return spawnSync(process.execPath, [fileURLToPath(script), file], { encoding: "utf8" });
}

test("mutation summary separates detected, surviving, uncovered and invalid mutants", (t) => {
  const result = summarize(t, {
    files: {
      "server/policy.js": {
        mutants: [
          "Killed",
          "Timeout",
          "Survived",
          "NoCoverage",
          "CompileError",
          "RuntimeError",
          "Ignored",
        ].map((status) => ({ status })),
      },
      "server/paths.js": { mutants: [{ status: "Killed" }] },
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /server\/policy\.js.*50\.00%.*\| 1 \| 1 \| 1 \| 1 \| 2 \| 1 \|/,
  );
  assert.match(result.stdout, /server\/paths\.js.*100\.00%/);
  assert.match(result.stdout, /\*\*Total\*\*.*60\.00%.*\| 2 \| 1 \| 1 \| 1 \| 2 \| 1 \|/);
  assert.match(result.stdout, /pilot scope/i);
});

test("a report with only invalid mutants does not claim a perfect score", (t) => {
  const result = summarize(t, {
    files: { "invalid.js": { mutants: [{ status: "CompileError" }] } },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /invalid\.js.*n\/a/);
  assert.doesNotMatch(result.stdout, /100\.00%/);
});

test("missing and empty reports fail without printing a successful summary", (t) => {
  for (const report of [undefined, {}, { files: {} }]) {
    const result = summarize(t, report);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mutation report/i);
    assert.equal(result.stdout, "");
  }
});

test("unknown mutant statuses fail instead of being silently dropped from the score", (t) => {
  const result = summarize(t, {
    files: { "policy.js": { mutants: [{ status: "Pending" }] } },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pending/);
  assert.equal(result.stdout, "");
});
