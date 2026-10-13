import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  failedFiles,
  retryOutcome,
  retryPlan,
  summaryMarkdown,
} from "../../scripts/test-retry.mjs";

const reporter = fileURLToPath(
  new URL("../../scripts/test-failures-reporter.mjs", import.meta.url),
);
const files = ["tests/unit/a.test.js", "tests/integration/b.test.js"];

test("failure lines name each failing file once, relative to the root", () => {
  const lines = [
    JSON.stringify({ file: "/repo/tests/unit/a.test.js", name: "one" }),
    JSON.stringify({ file: "/repo/tests/unit/a.test.js", name: "two" }),
    JSON.stringify({ file: "tests/integration/b.test.js", name: "three" }),
    "",
  ].join("\n");
  assert.deepEqual([...failedFiles(lines, "/repo")], files);
  assert.deepEqual([...failedFiles(JSON.stringify({ name: "x" }), "/repo")], [null]);
});

test("a passing run needs no retry", () => {
  assert.deepEqual(retryPlan({ status: 0, failures: new Set(), files }), { retry: [] });
});

test("only failed files are retried", () => {
  assert.deepEqual(retryPlan({ status: 1, failures: new Set([files[1]]), files }), {
    retry: [files[1]],
  });
});

test("failures that cannot be pinned to a run file are never retried", () => {
  assert.ok(retryPlan({ status: 1, failures: new Set(), files }).fail);
  assert.ok(retryPlan({ status: 1, failures: new Set([null]), files }).fail);
  assert.ok(
    retryPlan({ status: 1, failures: new Set(["tests/other.test.js"]), files }).fail,
  );
});

test("deterministic property seeds are never retried, even beside other failures", () => {
  const plan = retryPlan({
    status: 1,
    failures: new Set([files[0], "tests/property/seed.test.js"]),
    files: [...files, "tests/property/seed.test.js"],
    neverRetry: ["tests/property/"],
  });
  assert.match(plan.fail, /never retried failed: tests\/property\/seed\.test\.js/);
});

test("a file passing its retry is flaky; failing twice fails", () => {
  assert.deepEqual(
    retryOutcome({ retried: files, status: 1, failures: new Set([files[1]]) }),
    { flaky: [files[0]], failed: [files[1]] },
  );
  assert.deepEqual(retryOutcome({ retried: files, status: 0, failures: new Set() }), {
    flaky: files,
    failed: [],
  });
});

test("a retry that fails without a test file fails every retried file", () => {
  const outcome = retryOutcome({ retried: files, status: 1, failures: new Set() });
  assert.deepEqual(outcome.flaky, []);
  assert.deepEqual(outcome.failed, files);
  assert.ok(outcome.reason);
});

test("the step summary lists flaky and twice-failed files", () => {
  const markdown = summaryMarkdown({
    label: "all",
    flaky: [files[0]],
    failed: [files[1]],
  });
  assert.match(markdown, /### Test file retries: all/);
  assert.match(markdown, /`tests\/unit\/a\.test\.js` \| FLAKY \(passed on retry\)/);
  assert.match(markdown, /`tests\/integration\/b\.test\.js` \| FAILED twice/);
  assert.equal(summaryMarkdown({ flaky: [], failed: [] }), "");
  assert.match(
    summaryMarkdown({ flaky: [], failed: [], reason: "x" }),
    /Not retried: x\./,
  );
});

test("the reporter names the files of real node:test failures", (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-test-retry-")),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, body) => {
    fs.writeFileSync(
      path.join(directory, name),
      `import test from "node:test";\n${body}`,
    );
    return name;
  };
  const passing = write("pass.test.js", 'test("ok", () => {});\n');
  const failing = write(
    "fail.test.js",
    'test("nested", async (t) => { await t.test("inner", () => { throw new Error("x"); }); });\n' +
      'test("todo", { todo: true }, () => { throw new Error("todo"); });\n',
  );
  const crashing = write("crash.test.js", 'throw new Error("top-level");\n');
  const destination = path.join(directory, "failures.jsonl");
  // Without NODE_TEST_CONTEXT the child is a top-level runner, as in CI.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  void NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    [
      "--test",
      `--test-reporter=${reporter}`,
      `--test-reporter-destination=${destination}`,
      passing,
      failing,
      crashing,
    ],
    { cwd: directory, encoding: "utf8", env },
  );
  assert.equal(child.status, 1);
  assert.deepEqual(
    [...failedFiles(fs.readFileSync(destination, "utf8"), directory)].sort(),
    [crashing, failing],
  );
});
