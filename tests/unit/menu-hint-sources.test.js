import test from "node:test";
import assert from "node:assert/strict";
import {
  MENU_HINT_RUN_TOPICS,
  menuHintSources,
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
