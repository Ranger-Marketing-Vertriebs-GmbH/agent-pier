import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ciNodeVersion,
  findNodeVersionViolations,
  nodeVersionViolation,
} from "../../scripts/ci-node-versions.mjs";
import { ciPlan } from "../../scripts/affected/ci-plan.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const engines = "^22.23.4 || ^24.22.1 || >=26.12.1";
const setupNode = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";

function fixture(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ci-node-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ engines: { node: engines } }),
  );
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const job = (steps, strategy = "") =>
  `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n${strategy}    steps:\n${steps}`;
const step = (version) =>
  `      - uses: ${setupNode}\n        with:\n          node-version: ${version}\n`;

test("only versions that cannot resolve below the engines floor pass", () => {
  for (const value of [
    ">=22.23.4 <23",
    ">=24.22.1 <25",
    ">=24.23.0 <25",
    ">=26.12.1 <27",
    ">=26.12.1",
    "22.23.4",
    "24.22.1",
    "27.0.0",
  ])
    assert.equal(nodeVersionViolation(value, engines), null, value);
  for (const value of [
    "24",
    "22",
    "24.x",
    "lts/*",
    "latest",
    "node",
    "",
    ">=24.19.0 <25",
    ">=24.22.1",
    ">=24.22.1 <26",
    ">=22.23.4 <25",
    ">=23.0.0 <24",
    "24.19.0",
    "25.0.0",
    "^24.22.1",
  ])
    assert.match(nodeVersionViolation(value, engines), /engines/, value);
});

test("the CI range for a major starts at its engines floor", () => {
  assert.equal(ciNodeVersion(22, engines), ">=22.23.4 <23");
  assert.equal(ciNodeVersion(24, engines), ">=24.22.1 <25");
  assert.equal(ciNodeVersion(26, engines), ">=26.12.1 <27");
  assert.throws(() => ciNodeVersion(25, engines), /engines/);
});

test("bare majors, missing versions and unresolvable expressions in workflows fail", (t) => {
  const dir = fixture(t, {
    ".github/workflows/bare.yml": job(step("24")),
    ".github/workflows/missing.yml": job(`      - uses: ${setupNode}\n`),
    ".github/workflows/expression.yml": job(step("${{ inputs.node }}")),
    ".github/actions/shard/action.yml": `runs:\n  using: composite\n  steps:\n    - uses: ${setupNode}\n      with:\n        node-version: 22\n`,
    ".github/workflows/ok.yml": job(step('">=24.22.1 <25"') + step("22.23.4")),
  });
  const violations = findNodeVersionViolations(dir);
  assert.equal(violations.length, 4, violations.join("\n"));
  assert.match(violations.join("\n"), /bare\.yml: test: "24"/);
  assert.match(violations.join("\n"), /missing\.yml: test: .*no node-version/);
  assert.match(violations.join("\n"), /expression\.yml: test: .*inputs\.node/);
  assert.match(violations.join("\n"), /shard\/action\.yml: .*"22"/);
});

test("matrix values are checked, including combinations that set no version", (t) => {
  const strategy = (matrix) => `    strategy:\n      matrix:\n${matrix}`;
  const dir = fixture(t, {
    ".github/workflows/list.yml": job(
      step("${{ matrix.node }}"),
      strategy("        node: [22, 24]\n"),
    ),
    ".github/workflows/include.yml": job(
      step("${{ matrix.node-version }}"),
      strategy(
        '        node: [22, 24, 26]\n        include:\n          - node: 22\n            node-version: ">=22.23.4 <23"\n          - node: 24\n            node-version: ">=24.19.0 <25"\n',
      ),
    ),
    ".github/workflows/dynamic.yml": job(
      step("${{ matrix.node-version }}"),
      strategy(
        `        include: \${{ fromJSON(needs.plan.outputs.backend || '[{"os":"ubuntu-latest","node":24}]') }}\n`,
      ),
    ),
    ".github/workflows/fine.yml": job(
      step("${{ matrix.node-version }}"),
      strategy(
        '        os: [ubuntu-latest, macos-latest]\n        node: [22, 24]\n        include:\n          - node: 22\n            node-version: ">=22.23.4 <23"\n          - node: 24\n            node-version: ">=24.22.1 <25"\n',
      ),
    ),
  });
  const text = findNodeVersionViolations(dir).join("\n");
  assert.match(text, /list\.yml: test: "22"/);
  assert.match(text, /list\.yml: test: "24"/);
  assert.match(text, /include\.yml: test: ">=24\.19\.0 <25"/);
  assert.match(text, /include\.yml: test: .*node=26.* no node-version/);
  assert.match(text, /dynamic\.yml: test: .*no node-version/);
  assert.doesNotMatch(text, /fine\.yml/);
});

test("every workflow and composite action in the repository honours the engines floor", () => {
  assert.deepEqual(findNodeVersionViolations(root), []);
});

test("the verify plan sets each backend's Node range from the engines floor", () => {
  const { engines: own } = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  for (const full of [true, false]) {
    const plan = ciPlan(
      { mode: "all", node: [], browser: [], macos: true },
      { full, nodeTotal: 0 },
    );
    for (const entry of plan.backend) {
      assert.equal(entry["node-version"], ciNodeVersion(entry.node, own.node));
      assert.equal(nodeVersionViolation(entry["node-version"], own.node), null);
    }
  }
});

test("the structure check includes the CI Node versions", () => {
  const run = spawnSync(process.execPath, ["scripts/check-structure.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /setup-node versions at or above the engines floor/);
});
