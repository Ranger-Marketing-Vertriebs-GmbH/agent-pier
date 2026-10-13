import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  retryFailed,
  retryOutcome,
  retryPlan,
  runEvents,
  summaryMarkdown,
} from "../../scripts/test-retry.mjs";

const reporter = fileURLToPath(
  new URL("../../scripts/test-failures-reporter.mjs", import.meta.url),
);
const files = ["tests/unit/a.test.js", "tests/integration/b.test.js"];
// A first or retry run whose runner exited on its own after its final summary.
const finished = { signal: null, complete: true };

test("reporter lines give failing files, skipped tests and completion", () => {
  const lines = [
    JSON.stringify({ file: "/repo/tests/unit/a.test.js", name: "one" }),
    JSON.stringify({ file: "/repo/tests/unit/a.test.js", name: "two" }),
    JSON.stringify({ file: "tests/integration/b.test.js", name: "three" }),
    "",
  ].join("\n");
  const events = runEvents(lines, "/repo");
  assert.deepEqual([...events.failures], files);
  assert.equal(events.complete, false);
  assert.deepEqual(
    [...runEvents(JSON.stringify({ name: "x" }), "/repo").failures],
    [null],
  );
  const skipped = JSON.stringify({ file: "/repo/a.test.js", name: "s", skip: true });
  const done = JSON.stringify({ complete: true });
  assert.deepEqual(runEvents(`${lines}\n${skipped}\n${done}`, "/repo"), {
    failures: new Set(files),
    skipped: ["s"],
    complete: true,
  });
});

test("a passing run needs no retry", () => {
  assert.deepEqual(retryPlan({ ...finished, status: 0, failures: new Set(), files }), {
    retry: [],
  });
});

test("only failed files are retried", () => {
  assert.deepEqual(
    retryPlan({ ...finished, status: 1, failures: new Set([files[1]]), files }),
    { retry: [files[1]] },
  );
});

test("a runner that did not finish is never retried", () => {
  // Killed after a flaky failure: later files may never have run.
  const failures = new Set([files[0]]);
  assert.match(
    retryPlan({ status: 1, signal: "SIGKILL", complete: false, failures, files }).fail,
    /stopped by SIGKILL/,
  );
  assert.match(
    retryPlan({ status: 1, signal: null, complete: false, failures, files }).fail,
    /without its final summary/,
  );
  assert.ok(
    retryPlan({ status: 0, signal: "SIGTERM", complete: true, failures, files }).fail,
  );
});

test("failures that cannot be pinned to a run file are never retried", () => {
  const plan = (failures) => retryPlan({ ...finished, status: 1, failures, files });
  assert.ok(plan(new Set()).fail);
  assert.ok(plan(new Set([null])).fail);
  assert.ok(plan(new Set(["tests/other.test.js"])).fail);
});

test("deterministic property seeds are never retried, even beside other failures", () => {
  const plan = retryPlan({
    ...finished,
    status: 1,
    failures: new Set([files[0], "tests/property/seed.test.js"]),
    files: [...files, "tests/property/seed.test.js"],
    neverRetry: ["tests/property/"],
  });
  assert.match(plan.fail, /never retried failed: tests\/property\/seed\.test\.js/);
});

test("a file passing a finished retry is flaky; failing twice fails", () => {
  const twice = retryOutcome({
    ...finished,
    retried: files,
    status: 1,
    failures: new Set([files[1]]),
  });
  assert.deepEqual(twice, { flaky: [files[0]], failed: [files[1]] });
  assert.equal(retryFailed(twice), true);
  const flaky = retryOutcome({
    ...finished,
    retried: files,
    status: 0,
    failures: new Set(),
  });
  assert.deepEqual(flaky, { flaky: files, failed: [] });
  assert.equal(retryFailed(flaky), false);
});

test("an unfinished retry run proves no file flaky", () => {
  for (const run of [
    { signal: "SIGKILL", complete: false, status: 1 },
    { signal: null, complete: false, status: 0 },
  ]) {
    const outcome = retryOutcome({ ...run, retried: files, failures: new Set() });
    assert.deepEqual(outcome.flaky, []);
    assert.deepEqual(outcome.failed, files);
    assert.match(outcome.reason, /^retry: /);
  }
});

test("a retry that fails without a test file fails every retried file", () => {
  const outcome = retryOutcome({
    ...finished,
    retried: files,
    status: 1,
    failures: new Set(),
  });
  assert.deepEqual(outcome.flaky, []);
  assert.deepEqual(outcome.failed, files);
  assert.ok(outcome.reason);
});

test("more flaky files than the cap fail the run", () => {
  const retried = ["a.test.js", "b.test.js", "c.test.js"];
  const pass = { ...finished, retried, status: 0, failures: new Set() };
  const capped = retryOutcome({ ...pass, maxFlaky: 2 });
  assert.deepEqual(capped.flaky, retried);
  assert.equal(capped.capped, true);
  assert.match(capped.reason, /3 flaky files exceed the cap of 2/);
  assert.equal(retryFailed(capped), true);
  assert.equal(retryFailed(retryOutcome({ ...pass, maxFlaky: 3 })), false);
  assert.equal(retryFailed(retryOutcome(pass)), true, "the default cap is 2");
});

test("the step summary lists flaky and twice-failed files and the cap", () => {
  const markdown = summaryMarkdown({
    label: "all",
    flaky: [files[0]],
    failed: [files[1]],
    maxFlaky: 2,
  });
  assert.match(markdown, /### Test file retries: all/);
  assert.match(markdown, /`tests\/unit\/a\.test\.js` \| FLAKY \(passed on retry\)/);
  assert.match(markdown, /`tests\/integration\/b\.test\.js` \| FAILED twice/);
  assert.match(markdown, /At most 2 flaky files per run pass; one more fails the job\./);
  assert.equal(summaryMarkdown({ flaky: [], failed: [] }), "");
  assert.match(
    summaryMarkdown({ flaky: [], failed: [], reason: "x" }),
    /Failed without a retry pass: x\./,
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
      'test("todo", { todo: true }, () => { throw new Error("todo"); });\n' +
      'test("skipped", { skip: "no runtime" }, () => {});\n',
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
    [...runEvents(fs.readFileSync(destination, "utf8"), directory).failures].sort(),
    [crashing, failing],
  );
  const events = runEvents(fs.readFileSync(destination, "utf8"), directory);
  assert.deepEqual(events.skipped, ["skipped"]);
  assert.equal(events.complete, true);
});
