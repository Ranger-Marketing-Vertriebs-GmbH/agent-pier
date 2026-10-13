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
  skippedTests,
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
  const skipped = JSON.stringify({ file: "/repo/a.test.js", name: "s", skip: true });
  assert.deepEqual([...failedFiles(skipped, "/repo")], []);
  assert.deepEqual(skippedTests(`${lines}\n${skipped}`), ["s"]);
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
    [...failedFiles(fs.readFileSync(destination, "utf8"), directory)].sort(),
    [crashing, failing],
  );
  assert.deepEqual(skippedTests(fs.readFileSync(destination, "utf8")), ["skipped"]);
});

function runnerRoot(t, tests) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-test-runner-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "tests/helpers"), { recursive: true });
  for (const name of [
    "test-files.mjs",
    "test-runner.mjs",
    "test-retry.mjs",
    "test-failures-reporter.mjs",
  ])
    fs.copyFileSync(
      fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url)),
      path.join(root, "scripts", name),
    );
  fs.writeFileSync(path.join(root, "tests/helpers/tmux-reaper.js"), "");
  for (const [name, body] of Object.entries(tests))
    fs.writeFileSync(path.join(root, name), `import test from "node:test";\n${body}`);
  return root;
}

function runFiles(root, args) {
  const { NODE_TEST_CONTEXT, GITHUB_STEP_SUMMARY, ...env } = process.env;
  (void NODE_TEST_CONTEXT, GITHUB_STEP_SUMMARY);
  return spawnSync(process.execPath, ["scripts/test-files.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, GITHUB_STEP_SUMMARY: path.join(root, "summary.md") },
  });
}

test("the files runner retries a flaky file once and reports it", (t) => {
  const root = runnerRoot(t, {
    "flaky.test.js":
      'import fs from "node:fs";\n' +
      'test("flaky", () => { if (!fs.existsSync("marker")) { fs.writeFileSync("marker", ""); throw new Error("first"); } });\n',
    "ok.test.js": 'test("ok", () => {});\n',
  });
  const result = runFiles(root, [
    "--retry",
    "--label",
    "core",
    "flaky.test.js",
    "ok.test.js",
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Retrying 1 failed test file\(s\) once\./);
  assert.match(result.stdout, /FLAKY \(passed on retry\): flaky\.test\.js/);
  assert.match(fs.readFileSync(path.join(root, "summary.md"), "utf8"), /: core/);
});

test("the files runner fails a file that fails twice", (t) => {
  const root = runnerRoot(t, {
    "broken.test.js": 'test("b", () => { throw new Error("x"); });\n',
  });
  const result = runFiles(root, ["--retry", "broken.test.js"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAILED twice: broken\.test\.js/);
});

test("the files runner never retries without --retry and rejects skips with --no-skips", (t) => {
  const root = runnerRoot(t, {
    "broken.test.js": 'test("b", () => { throw new Error("x"); });\n',
    "skip.test.js": 'test("needs runtime", { skip: "missing" }, () => {});\n',
  });
  const plain = runFiles(root, ["broken.test.js"]);
  assert.equal(plain.status, 1);
  assert.doesNotMatch(plain.stdout, /Retrying/);
  assert.equal(runFiles(root, ["skip.test.js"]).status, 0);
  const strict = runFiles(root, ["--no-skips", "--retry", "skip.test.js"]);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /SKIPPED \(not allowed here\): needs runtime/);
});
