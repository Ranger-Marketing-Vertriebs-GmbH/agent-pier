import test from "node:test";
import assert from "node:assert/strict";
import {
  MENU_HINT_RUN_TOPICS,
  menuHintSources,
  startRunSources,
} from "../../web/app/menu-hint-sources.js";

const loaded = (data) => ({ data, loading: false });
const loading = { data: null, loading: true };
const counts = {
  counts: { running: 1, "awaiting-human": 2, completed: 7, failed: 4, cancelled: 0 },
  total: 14,
};
const page = (...ids) => ({ runs: ids.map((id) => ({ id })), total: 99, page: 1 });

test("the hints follow the counts and page 1 of three statuses", () => {
  assert.deepEqual(MENU_HINT_RUN_TOPICS, {
    decisions: "pipeline.runs:*:awaiting-human",
    failed: "pipeline.runs:*:failed",
    running: "pipeline.runs:*:running",
  });
});

test("the sources keep the shape the menu and the start page read", () => {
  const sources = menuHintSources({
    counts: loaded(counts),
    decisions: loaded(page("d1")),
    failed: loaded(page("f1", "f2")),
    running: loaded(page("r1")),
    problems: loaded({ agentsEnabled: false }),
    summary: loaded({ operations: {} }),
    updates: loaded({ updateAvailable: true }),
  });
  assert.deepEqual(sources, {
    decisions: 2,
    failed: 4,
    running: 1,
    runs: {
      decisions: [{ id: "d1" }],
      failed: [{ id: "f1" }, { id: "f2" }],
      running: [{ id: "r1" }],
    },
    problems: { agentsEnabled: false },
    summary: { operations: {} },
    updates: { updateAvailable: true },
  });
});

test("the sources are null until every followed topic answered", () => {
  const parts = {
    counts: loaded(counts),
    decisions: loaded(page()),
    failed: loaded(page()),
    running: loaded(page()),
    problems: loaded({}),
    summary: loaded({}),
    updates: null,
  };
  assert.notEqual(menuHintSources(parts), null);
  assert.equal(menuHintSources(parts).updates, null);
  for (const key of Object.keys(parts))
    assert.equal(menuHintSources({ ...parts, [key]: loading }), null, key);
});

test("a failed source is null, never a zero", () => {
  const failed = { data: null, loading: false, error: "down" };
  const sources = menuHintSources({
    counts: failed,
    decisions: failed,
    failed: loaded({ runs: "nope" }),
    running: loaded(page()),
    problems: failed,
    summary: failed,
    updates: null,
  });
  assert.equal(sources.decisions, null);
  assert.equal(sources.failed, null);
  assert.equal(sources.running, null);
  assert.deepEqual(sources.runs, { decisions: null, failed: null, running: [] });
  assert.equal(sources.problems, null);
  assert.equal(sources.summary, null);
  // Counts of an unknown shape count as unknown.
  const odd = menuHintSources({
    counts: loaded({ counts: { running: "x" } }),
    decisions: loaded(page()),
    failed: loaded(page()),
    running: loaded(page()),
    problems: loaded({}),
    summary: loaded({}),
    updates: null,
  });
  assert.equal(odd.running, null);
  assert.equal(odd.decisions, null);
});

// AGENTPIER-339: the start page's pipelines card stayed a skeleton while another
// source (the connection problems) had not answered.
test("the start page's run sources wait for nothing but their own topics", () => {
  const parts = {
    counts: loaded({ counts: { running: 0, "awaiting-human": 0, failed: 0 }, total: 0 }),
    decisions: loaded(page()),
    failed: loaded(page()),
    running: loaded(page()),
    problems: loading,
    summary: loading,
    updates: loading,
  };
  assert.equal(menuHintSources(parts), null);
  assert.deepEqual(startRunSources(parts), {
    lists: { decisions: [], failed: [], running: [] },
    counts: { decisions: 0, failed: 0, running: 0 },
  });
});

test("a run source is undefined while it loads and null once it failed", () => {
  const failed = { data: null, loading: false, error: "down" };
  assert.deepEqual(
    startRunSources({
      counts: loading,
      decisions: loading,
      failed: failed,
      running: loaded({ runs: "nope" }),
    }),
    {
      lists: { decisions: undefined, failed: null, running: null },
      counts: undefined,
    },
  );
  assert.equal(startRunSources({ counts: failed }).counts, null);
  // A topic not followed (null) counts as loading: the start page follows them all.
  assert.equal(startRunSources({ counts: null }).lists.running, undefined);
});
