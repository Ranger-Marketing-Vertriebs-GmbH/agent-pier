import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "../..");
const verify = YAML.parse(
  fs.readFileSync(path.join(root, ".github/workflows/verify.yml"), "utf8"),
);
const required = ["backend", "chromium"];

const outputsOf = (text) =>
  Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );

function plan(t, ...args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-plan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, "github-output");
  fs.writeFileSync(output, "");
  const run = spawnSync(
    process.execPath,
    ["scripts/affected-tests.mjs", ...args, "--github-output", output],
    { cwd: root, encoding: "utf8" },
  );
  return { ...run, outputs: outputsOf(fs.readFileSync(output, "utf8")) };
}

test("the command line writes the queue plan with --full and all suites for an unknown base", (t) => {
  const queue = plan(t, "--full");
  assert.equal(queue.status, 0, queue.stderr);
  assert.equal(queue.outputs.full, "true");
  assert.equal(queue.outputs["node-all"], "true");
  assert.equal(queue.outputs["browser-tests"], "");
  assert.equal(queue.outputs["browser-shards"], "[1,2,3,4]");
  assert.deepEqual(JSON.parse(queue.outputs.backend), [
    { os: "ubuntu-latest", node: 24 },
    { os: "macos-latest", node: 24 },
  ]);
  const unknown = plan(t, "--base", "0".repeat(40));
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(unknown.outputs.mode, "all");
  assert.equal(unknown.outputs["node-all"], "true");
  assert.equal(unknown.outputs["browser-shards"], "[1,2,3,4]");
  const empty = plan(t, "--base", "");
  assert.notEqual(empty.status, 0);
  assert.equal(empty.outputs.mode, undefined);
});

test("the merge queue always plans every suite; only a pull request selects", () => {
  const step = verify.jobs.select.steps.find((candidate) => candidate.id === "plan");
  assert.match(
    step.run,
    /if \[ "\$EVENT" = pull_request \]; then\n\s+node scripts\/affected-tests\.mjs --base "\$BASE_SHA"/,
  );
  assert.match(step.run, /else\n\s+node scripts\/affected-tests\.mjs --full /);
  assert.equal(step.env.EVENT, "${{ github.event_name }}");
  assert.deepEqual(Object.keys(verify.on).sort(), ["merge_group", "pull_request"]);
});

test("required jobs always report and never pass on a failed plan", () => {
  for (const id of required) {
    const job = verify.jobs[id];
    assert.equal(job.if, "${{ !cancelled() }}", id);
    assert.ok([job.needs].flat().includes("select"), id);
  }
  assert.equal(
    verify.jobs.backend.name,
    "backend (${{ matrix.os }}, ${{ matrix.node }})",
  );
  assert.equal(verify.jobs.chromium.name, "browser (chromium)");
  const [guard] = verify.jobs.backend.steps;
  assert.equal(guard.name, "Require a test plan");
  assert.equal(guard.env.SELECT, "${{ needs.select.result }}");
  assert.equal(guard.run.trim(), 'test "$SELECT" = success');
  for (const [id, job] of Object.entries(verify.jobs)) {
    assert.equal(job["continue-on-error"], undefined, id);
    for (const step of job.steps || [])
      assert.equal(step["continue-on-error"], undefined, `${id}: ${step.name}`);
  }
});

test("the Chromium check passes only for passed shards or a plan without specs", () => {
  const [step] = verify.jobs.chromium.steps;
  const check = (SELECT, SHARDS, PLANNED) =>
    spawnSync("bash", ["-e", "-c", step.run], {
      env: { ...process.env, SELECT, SHARDS, PLANNED },
      encoding: "utf8",
    }).status;
  assert.equal(check("success", "success", "[1,2]"), 0);
  assert.equal(check("success", "skipped", "[]"), 0);
  assert.notEqual(check("success", "failure", "[1,2]"), 0);
  assert.notEqual(check("success", "cancelled", "[1]"), 0);
  assert.notEqual(check("success", "skipped", "[1]"), 0);
  assert.notEqual(check("success", "success", "[]"), 0);
  // A failed plan has no outputs and skipped shards: still red.
  assert.notEqual(check("failure", "skipped", ""), 0);
  assert.notEqual(check("failure", "skipped", "[]"), 0);
});

test("selected test and spec lists are never glob-expanded", () => {
  const nodeStep = verify.jobs.backend.steps.find(
    (step) => step.name === "Affected node tests",
  );
  assert.match(nodeStep.run, /read -ra tests <<< "\$TESTS"/);
  assert.match(nodeStep.run, /"\$\{tests\[@\]\}"/);
  const action = fs.readFileSync(
    path.join(root, ".github/actions/browser-shard/action.yml"),
    "utf8",
  );
  assert.match(action, /read -ra specs <<< "\$SPECS"/);
  assert.match(action, /"\$\{specs\[@\]\}"/);
  const list = "tests/unit/[ab].test.js tests/unit/*.test.js";
  const words = spawnSync(
    "bash",
    ["-e", "-c", 'read -ra tests <<< "$TESTS"; printf "%s\\n" "${tests[@]}"'],
    { cwd: root, env: { ...process.env, TESTS: list }, encoding: "utf8" },
  ).stdout;
  assert.equal(words, "tests/unit/[ab].test.js\ntests/unit/*.test.js\n");
});
