import test from "node:test";
import assert from "node:assert/strict";
import {
  allSpecs,
  loadTimings,
  shardProcesses,
  splitSpecs,
  weigher,
} from "../../scripts/browser-shards.mjs";
import { medianTimings, specSeconds } from "../../scripts/browser-shard-timings.mjs";

const specs = allSpecs();
const sum = (values) => values.reduce((total, value) => total + value, 0);

test("the recorded timings name only browser specs, with positive seconds", () => {
  for (const browser of ["chromium", "webkit"]) {
    const seconds = loadTimings(browser);
    assert.ok(Object.keys(seconds).length > 0, browser);
    for (const [spec, value] of Object.entries(seconds)) {
      assert.match(spec, /^tests\/browser\/.+\.spec\.js$/);
      assert.ok(value > 0, `${browser} ${spec}`);
    }
  }
  assert.equal(
    loadTimings("chromium", new URL("file:///nonexistent/timings.json")),
    null,
  );
});

test("CI shards partition every spec deterministically and stay balanced", () => {
  for (const [browser, total] of [
    ["chromium", 4],
    ["chromium", 8],
    ["webkit", 5],
    ["webkit", 10],
  ]) {
    const seconds = loadTimings(browser);
    const shards = splitSpecs(specs, total, seconds);
    const listed = shards.flatMap((shard) => shard.specs);
    assert.deepEqual([...listed].sort(), specs);
    assert.equal(new Set(listed).size, listed.length);
    assert.deepEqual(splitSpecs(specs, total, seconds), shards);
    // Greedy longest-first: no shard exceeds another by more than its longest spec.
    const weights = shards.map((shard) => shard.seconds);
    const longest = Math.max(...Object.values(seconds));
    assert.ok(
      Math.max(...weights) - Math.min(...weights) <= longest,
      `${browser}/${total}: ${weights}`,
    );
  }
});

test("a spec without a measurement weighs the median", () => {
  const seconds = { "a.spec.js": 10, "b.spec.js": 30, "c.spec.js": 50 };
  assert.equal(weigher(seconds)("new.spec.js"), 30);
  assert.equal(weigher({})("new.spec.js"), 1);
  const shards = splitSpecs(
    ["a.spec.js", "b.spec.js", "c.spec.js", "new.spec.js"],
    2,
    seconds,
  );
  assert.deepEqual(
    shards.map((shard) => shard.specs),
    [
      ["a.spec.js", "c.spec.js"],
      ["b.spec.js", "new.spec.js"],
    ],
  );
  assert.throws(() => splitSpecs(["a.spec.js"], 0), /Invalid total/);
  assert.throws(() => splitSpecs(["a.spec.js", "a.spec.js"], 1), /Duplicate/);
});

test("a shard job splits its specs over its processes, or falls back to --shard", () => {
  const seconds = loadTimings("chromium");
  const own = splitSpecs(specs, 4, seconds)[1].specs;
  const derived = shardProcesses({
    shard: 2,
    total: 4,
    processes: 2,
    specs: [],
    seconds,
  });
  assert.deepEqual(derived.flat().sort(), own);
  const weight = weigher(seconds);
  const [first, second] = derived.map((part) => sum(part.map(weight)));
  assert.ok(Math.abs(first - second) <= Math.max(...Object.values(seconds)));
  const named = shardProcesses({
    shard: 1,
    total: 1,
    processes: 2,
    specs: ["tests/browser/a.spec.js"],
    seconds,
  });
  assert.deepEqual(named, [["tests/browser/a.spec.js"]]);
  assert.deepEqual(
    shardProcesses({ shard: 3, total: 4, processes: 2, specs: [], seconds: null }),
    [["--shard=5/8"], ["--shard=6/8"]],
  );
  assert.deepEqual(
    shardProcesses({ shard: 3, total: 4, processes: 1, specs: [], seconds: null }),
    [["--shard=3/4"]],
  );
  assert.throws(
    () => shardProcesses({ shard: 5, total: 4, processes: 1, specs: [] }),
    /Invalid shard/,
  );
});

test("job logs give seconds per spec, per parallel process", () => {
  const log = [
    "2026-10-20T04:51:00.0000000Z Running 3 tests using 1 worker, shard 1 of 4",
    "2026-10-20T04:51:02.5000000Z   ✓    1 [desktop] › tests/browser/a.spec.js:5:1 › one (2.4s)",
    "2026-10-20T04:51:03.0000000Z   ✘    2 [desktop] › tests/browser/a.spec.js:9:1 › two (0.4s)",
    "2026-10-20T04:51:07.0000000Z   -    3 [tablet] › tests/browser/b.spec.js:3:1 › three",
    "2026-10-20T04:51:00.0000000Z [p2] Running 1 test using 1 worker",
    "2026-10-20T04:51:10.0000000Z [p2]   \u001b[32m✓\u001b[39m  1 [desktop] › tests/browser/c.spec.js:1:1 › c (9.9s)",
    "2026-10-20T04:51:11.0000000Z   4 passed (11s)",
  ].join("\n");
  assert.deepEqual(specSeconds(log), {
    "tests/browser/a.spec.js": 3,
    "tests/browser/b.spec.js": 4,
    "tests/browser/c.spec.js": 10,
  });
  assert.deepEqual(
    medianTimings({
      webkit: { "b.spec.js": [3, 9, 4] },
      chromium: { "a.spec.js": [1, 2.25] },
    }),
    { chromium: { "a.spec.js": 1.6 }, webkit: { "b.spec.js": 4 } },
  );
});
