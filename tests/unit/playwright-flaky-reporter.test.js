import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import FlakyReporter, {
  flakyMarkdown,
} from "../../scripts/playwright-flaky-reporter.mjs";

function result(outcome, statuses) {
  return {
    outcome: () => outcome,
    location: { file: path.join(process.cwd(), "tests/browser/login.spec.js"), line: 8 },
    titlePath: () => ["", "desktop", "login.spec.js", "first user | setup"],
    parent: { project: () => ({ name: "desktop" }) },
    results: statuses.map((status) => ({ status })),
  };
}

test("tests that passed only on retry are logged and summarized", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-flaky-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const summaryFile = path.join(directory, "summary.md");
  const lines = [];
  const reporter = new FlakyReporter({ summaryFile, log: (line) => lines.push(line) });
  reporter.onTestEnd(result("expected", ["passed"]));
  reporter.onTestEnd(result("unexpected", ["failed", "failed"]));
  reporter.onTestEnd(result("flaky", ["failed", "passed"]));
  reporter.onEnd();
  assert.ok(
    lines.includes(
      "FLAKY (passed on retry): tests/browser/login.spec.js:8 first user | setup",
    ),
  );
  const summary = fs.readFileSync(summaryFile, "utf8");
  assert.match(summary, /### Browser tests that passed only on retry/);
  assert.match(
    summary,
    /\| `tests\/browser\/login\.spec\.js:8` first user \\\| setup \| desktop \| 1 \|/,
  );
  assert.equal(summary.match(/login\.spec/g).length, 1);
});

test("a run without flaky tests writes no summary", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-flaky-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const summaryFile = path.join(directory, "summary.md");
  const reporter = new FlakyReporter({ summaryFile, log: () => {} });
  reporter.onTestEnd(result("unexpected", ["failed", "failed"]));
  reporter.onEnd();
  assert.equal(fs.existsSync(summaryFile), false);
  assert.equal(flakyMarkdown([]), "");
});
