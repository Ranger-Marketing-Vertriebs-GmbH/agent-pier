import test from "node:test";
import assert from "node:assert/strict";
import {
  ciPlan,
  filesystemMatrix,
  githubOutput,
} from "../../scripts/affected/ci-plan.mjs";

const linux = { os: "ubuntu-latest", node: 24 };
const macos = { os: "macos-latest", node: 24 };
const totals = { nodeTotal: 10, browserTotal: 200 };
const selection = (overrides) => ({
  mode: "selected",
  node: [],
  browser: [],
  reasons: [],
  macos: false,
  ...overrides,
});

test("the merge queue plans every suite with the advisory macOS backend", () => {
  const plan = ciPlan(null, { full: true });
  assert.equal(plan["node-all"], true);
  assert.deepEqual(plan.backend, [linux, macos]);
  assert.deepEqual(plan["browser-shards"], [1, 2, 3, 4]);
  assert.equal(plan["browser-tests"], "");
  assert.deepEqual(plan["filesystem-os"], ["ubuntu-latest"]);
  assert.equal(plan.nono, true);
});

test("a pull request runs only its selection, on Linux", () => {
  const plan = ciPlan(
    selection({
      node: ["tests/unit/a.test.js", "tests/unit/b.test.js"],
      browser: Array.from(
        { length: 51 },
        (_, index) => `tests/browser/s${index}.spec.js`,
      ),
    }),
    totals,
  );
  assert.equal(plan["node-all"], false);
  assert.equal(plan["node-tests"], "tests/unit/a.test.js tests/unit/b.test.js");
  assert.deepEqual(plan["browser-shards"], [1, 2, 3]);
  assert.match(plan["browser-tests"], /^tests\/browser\/s0\.spec\.js /);
  assert.deepEqual(plan.backend, [linux]);
  assert.deepEqual(plan["filesystem-os"], []);
  assert.equal(plan.nono, false);
  assert.equal(plan["agentbus-runtimes"], false);
});

test("documentation plans no test job but keeps the required backend", () => {
  const plan = ciPlan(selection({ mode: "none" }), totals);
  assert.equal(plan["node-tests"], "");
  assert.deepEqual(plan["browser-shards"], []);
  assert.deepEqual(plan.backend, [linux]);
});

test("everything selected runs whole suites; platform code adds macOS where tested", () => {
  const all = ciPlan(selection({ mode: "all", macos: true }), totals);
  assert.equal(all["node-all"], true);
  assert.equal(all["browser-tests"], "");
  assert.deepEqual(all["browser-shards"], [1, 2, 3, 4]);
  assert.deepEqual(all.backend, [linux, macos]);
  assert.deepEqual(all["filesystem-os"], ["ubuntu-latest", "macos-latest"]);
  const untested = ciPlan(selection({ macos: true }), totals);
  assert.deepEqual(untested.backend, [linux]);
  const filesystem = ciPlan(selection({ node: [filesystemMatrix[1]] }), totals);
  assert.deepEqual(filesystem["filesystem-os"], ["ubuntu-latest"]);
});

test("plans are written as GitHub step outputs", () => {
  assert.equal(
    githubOutput({ mode: "none", full: false, list: [1] }),
    "mode=none\nfull=false\nlist=[1]",
  );
});
