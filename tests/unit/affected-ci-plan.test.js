import test from "node:test";
import assert from "node:assert/strict";
import {
  browserShards,
  ciPlan,
  filesystemMatrix,
  githubOutput,
} from "../../scripts/affected/ci-plan.mjs";

const linux = { os: "ubuntu-latest", node: 24 };
const macos = { os: "macos-latest", node: 24 };
const allSpecs = Array.from(
  { length: 200 },
  (_, index) => `tests/browser/s${index}.spec.js`,
);
const timings = Object.fromEntries(
  allSpecs.map((spec, index) => [spec, (index % 7) + 5]),
);
const totals = { nodeTotal: 10, browserSpecs: allSpecs, timings };
const listed = (shards) => shards.flatMap((shard) => shard.specs.split(" "));
const selection = (overrides) => ({
  mode: "selected",
  node: [],
  browser: [],
  reasons: [],
  macos: false,
  ...overrides,
});

test("the merge queue plans every suite with the advisory macOS backend", () => {
  const plan = ciPlan(null, { full: true, browserSpecs: allSpecs, timings });
  assert.equal(plan["node-all"], true);
  assert.deepEqual(plan.backend, [linux, macos]);
  assert.deepEqual(
    plan["browser-shards"].map((shard) => shard.shard),
    [1, 2, 3, 4],
  );
  assert.deepEqual(listed(plan["browser-shards"]).sort(), [...allSpecs].sort());
  assert.deepEqual(plan["filesystem-os"], ["ubuntu-latest"]);
  assert.equal(plan.nono, true);
});

test("a pull request runs only its selection, on Linux", () => {
  const plan = ciPlan(
    selection({
      node: ["tests/unit/a.test.js", "tests/unit/b.test.js"],
      browser: allSpecs.slice(0, 160),
    }),
    totals,
  );
  assert.equal(plan["node-all"], false);
  assert.equal(plan["node-tests"], "tests/unit/a.test.js tests/unit/b.test.js");
  // 160 specs of 5-11 s: 1277 s, three shards of about 600 s.
  assert.deepEqual(
    plan["browser-shards"].map((shard) => shard.shard),
    [1, 2, 3],
  );
  assert.deepEqual(listed(plan["browser-shards"]).sort(), allSpecs.slice(0, 160).sort());
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
  assert.equal(all["browser-shards"].length, 4);
  assert.deepEqual(listed(all["browser-shards"]).sort(), [...allSpecs].sort());
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

test("Chromium shards are balanced by recorded seconds or fall back to --shard", () => {
  const shards = browserShards(allSpecs, { all: true, timings });
  const seconds = shards.map((shard) =>
    shard.specs.split(" ").reduce((sum, spec) => sum + timings[spec], 0),
  );
  assert.ok(Math.max(...seconds) - Math.min(...seconds) <= 11, String(seconds));
  assert.deepEqual(browserShards(allSpecs, { all: true, timings }), shards);
  // No timing file: every spec through Playwright's --shard, a selection by count.
  assert.deepEqual(browserShards(allSpecs, { all: true, timings: null }), [
    { shard: 1, specs: "" },
    { shard: 2, specs: "" },
    { shard: 3, specs: "" },
    { shard: 4, specs: "" },
  ]);
  assert.equal(
    browserShards(allSpecs.slice(0, 51), { all: false, timings: null }).length,
    3,
  );
  assert.deepEqual(browserShards([], { all: false, timings }), []);
  // A single short spec still gets one shard.
  assert.deepEqual(
    browserShards(["tests/browser/new.spec.js"], { all: false, timings }),
    [{ shard: 1, specs: "tests/browser/new.spec.js" }],
  );
});
