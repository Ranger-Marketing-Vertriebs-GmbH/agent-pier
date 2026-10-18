import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    "test-process-sweep.mjs",
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
  // spawnSync blocks this test's event loop, so its own timeout cannot fire:
  // bound the nested run so a hanging runner fails here instead of the CI job.
  return spawnSync(process.execPath, ["scripts/test-files.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
    killSignal: "SIGKILL",
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

const flakyBody = (marker) =>
  'import fs from "node:fs";\n' +
  `test("flaky", () => { if (!fs.existsSync("${marker}")) { fs.writeFileSync("${marker}", ""); throw new Error("first"); } });\n`;

test("a runner killed after a flaky failure fails without a retry", (t) => {
  // Regression: the parent died while b ran, so c (a real failure) never ran.
  // A retry of a alone used to pass and exit 0.
  for (const signal of ["SIGKILL", "SIGTERM"]) {
    const root = runnerRoot(t, {
      "a.test.js": flakyBody("marker-a"),
      "b.test.js": `test("kill", () => { process.kill(process.ppid, "${signal}"); });\n`,
      "c.test.js": 'test("c", () => { throw new Error("real bug"); });\n',
    });
    const result = runFiles(root, ["--retry", "a.test.js", "b.test.js", "c.test.js"]);
    assert.notEqual(result.status, 0, `${signal}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /Retrying|FLAKY/, signal);
    assert.match(result.stdout, /Failed without a retry pass: the test runner/, signal);
  }
});

test("more than the flaky cap fails the run and says so", (t) => {
  const root = runnerRoot(t, {
    "a.test.js": flakyBody("marker-a"),
    "b.test.js": flakyBody("marker-b"),
    "c.test.js": flakyBody("marker-c"),
  });
  const result = runFiles(root, ["--retry", "a.test.js", "b.test.js", "c.test.js"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout.match(/FLAKY \(passed on retry\)/g).length, 3);
  assert.match(result.stdout, /3 flaky files exceed the cap of 2 per run/);
  const summary = fs.readFileSync(path.join(root, "summary.md"), "utf8");
  assert.match(summary, /At most 2 flaky files per run pass/);
  for (const marker of ["marker-a", "marker-b", "marker-c"])
    fs.rmSync(path.join(root, marker));
  assert.equal(
    runFiles(root, ["--retry", "--max-flaky", "3", "a.test.js", "b.test.js", "c.test.js"])
      .status,
    0,
  );
});

test("a hung test fails its file at the per-test timeout", (t) => {
  const root = runnerRoot(t, {
    "hang.test.js":
      'test("hang", () => new Promise(() => setInterval(() => {}, 1000)));\n',
  });
  const started = Date.now();
  const result = runFiles(root, ["--retry", "--test-timeout", "500", "hang.test.js"]);
  // Regression: on Node 24+ the file kept running after the timeout because
  // the test's interval held its event loop open, and the CI job hung.
  assert.equal(result.signal, null, "the runner must end on its own");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAILED twice: hang\.test\.js/);
  assert.ok(Date.now() - started < 30000);
});

test("the files runner does not retry files under a --never-retry prefix", (t) => {
  const root = runnerRoot(t, { "seeded.test.js": flakyBody("marker-seeded") });
  const result = runFiles(root, ["--retry", "--never-retry", "seeded", "seeded.test.js"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /FLAKY/);
});

test("each run gets a short private temp folder that is removed afterwards", (t) => {
  const root = runnerRoot(t, {
    "tmp.test.js":
      'import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\n' +
      'test("tmp", () => {\n' +
      '  fs.writeFileSync(path.join(os.tmpdir(), "left-behind"), "");\n' +
      '  fs.writeFileSync("seen.json", JSON.stringify({ tmp: os.tmpdir(), shared: process.env.AGENTPIER_TEST_SHARED_TMPDIR }));\n' +
      "});\n",
  });
  const result = runFiles(root, ["tmp.test.js"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const seen = JSON.parse(fs.readFileSync(path.join(root, "seen.json"), "utf8"));
  assert.notEqual(seen.tmp, os.tmpdir());
  assert.match(seen.tmp, /^\/tmp\/ap-[A-Za-z0-9]{6}$/);
  assert.equal(seen.shared, process.env.AGENTPIER_TEST_SHARED_TMPDIR || os.tmpdir());
  assert.equal(fs.existsSync(seen.tmp), false, "the run folder is removed");
});

test("a file that declares a longer timeout gets it; others keep the default", (t) => {
  const slow =
    'test("slow", async () => { await new Promise((r) => setTimeout(r, 2500)); });\n';
  const root = runnerRoot(t, {
    // The marker the runner reads from a file's first lines.
    "declared.test.js": `// test-runner-timeout-ms: 20000\n${slow}`,
    "plain.test.js": slow,
  });
  const declared = runFiles(root, ["--test-timeout", "1000", "declared.test.js"]);
  assert.equal(declared.status, 0, declared.stdout + declared.stderr);
  const plain = runFiles(root, ["--test-timeout", "1000", "plain.test.js"]);
  assert.notEqual(plain.status, 0, plain.stdout);
  // Both together: each keeps its own class, and the run fails only for the plain one.
  const both = runFiles(root, [
    "--test-timeout",
    "1000",
    "declared.test.js",
    "plain.test.js",
  ]);
  assert.notEqual(both.status, 0);
  assert.match(both.stdout, /✔ slow|ok 1 - slow/);
});

test("a process a test leaves behind is stopped and fails the run", (t) => {
  const root = runnerRoot(t, {
    // A detached child that ignores SIGTERM and outlives its test file.
    "leak.test.js":
      'import { spawn } from "node:child_process";\n' +
      'import fs from "node:fs";\n' +
      'test("leak", () => {\n' +
      '  const child = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });\n' +
      "  child.unref();\n" +
      '  fs.writeFileSync("leaked.pid", String(child.pid));\n' +
      "});\n",
    "ok.test.js": 'test("ok", () => {});\n',
  });
  const result = runFiles(root, ["leak.test.js"]);
  const pid = Number(fs.readFileSync(path.join(root, "leaked.pid"), "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  t.after(() => alive() && process.kill(pid, "SIGKILL"));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, new RegExp(`LEAKED PROCESS \\(stopped\\): ${pid} `));
  assert.equal(alive(), false);
  // A clean run reports nothing.
  const clean = runFiles(root, ["ok.test.js"]);
  assert.equal(clean.status, 0, clean.stdout);
  assert.doesNotMatch(clean.stdout, /LEAKED PROCESS/);
});
