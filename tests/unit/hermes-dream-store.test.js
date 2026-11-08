import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DreamingSettings } from "../../server/features/assistants/dreaming-settings.js";
import { HermesDreamStore } from "../../server/features/assistants/hermes-dream-store.js";

function opened(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-dream-store-"));
  const open = [];
  const reopen = () => {
    const settings = new DreamingSettings({ dataDir });
    open.push(settings);
    return new HermesDreamStore(settings.db);
  };
  t.after(() => {
    for (const settings of open) settings.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { reopen, close: () => open.pop().close() };
}

const entry = (n, summary = "") => ({
  at: new Date(Date.UTC(2026, 10, 1 + n, 2)).toISOString(),
  night: `2026-11-${String(1 + n).padStart(2, "0")}`,
  outcome: "applied",
  reason: null,
  file: null,
  counts: null,
  chars: null,
  summary,
});

test("cursor and night survive a reopen", (t) => {
  const f = opened(t);
  let store = f.reopen();
  assert.equal(store.cursor("a"), null);
  assert.equal(store.night("a"), null);
  store.markNight("a", "2026-11-08");
  assert.equal(store.cursor("a"), null);
  store.applied("a", 1762560000000);
  store.markNight("a", "2026-11-09");
  store.applied("b", 5);
  f.close();
  store = f.reopen();
  assert.equal(store.cursor("a"), 1762560000000);
  assert.equal(store.night("a"), "2026-11-09");
  assert.equal(store.cursor("b"), 5);
  assert.equal(store.night("b"), null);
  assert.equal(store.cursor("c"), null);
});

test("the diary keeps its newest entries within 256 KiB and says it was cut", (t) => {
  const store = opened(t).reopen();
  assert.deepEqual(store.diary("a"), {
    entries: [],
    size: 0,
    truncated: false,
    modifiedAt: null,
  });
  const big = "x".repeat(100000);
  const bytes = (e) => Buffer.byteLength(JSON.stringify(e));
  for (let n = 0; n < 4; n++) store.append("a", entry(n, `${n}${big}`));
  store.append("b", entry(0, "other"));
  const diary = store.diary("a");
  // 4 × ~100 KB: the two newest fit in 256 KiB, the older two are cut.
  assert.deepEqual(
    diary.entries.map((e) => e.summary[0]),
    ["3", "2"],
  );
  assert.deepEqual(diary.entries[0], entry(3, `3${big}`));
  assert.equal(diary.truncated, true);
  assert.equal(
    diary.size,
    [0, 1, 2, 3].reduce((sum, n) => sum + bytes(entry(n, `${n}${big}`)), 0),
  );
  assert.equal(diary.modifiedAt, entry(3).at);
  // Another agent's diary is its own.
  const other = store.diary("b");
  assert.equal(other.entries.length, 1);
  assert.equal(other.truncated, false);
  assert.equal(other.size, bytes(entry(0, "other")));
});

test("prune forgets removed agents", (t) => {
  const store = opened(t).reopen();
  for (const id of ["a", "b"]) {
    store.markNight(id, "2026-11-08");
    store.applied(id, 7);
    store.append(id, entry(0, "x".repeat(300000)));
    store.append(id, entry(1));
  }
  store.prune(new Set(["a"]));
  assert.equal(store.cursor("a"), 7);
  assert.equal(store.diary("a").entries.length, 1);
  assert.equal(store.diary("a").truncated, true);
  assert.equal(store.cursor("b"), null);
  assert.equal(store.night("b"), null);
  assert.deepEqual(store.diary("b"), {
    entries: [],
    size: 0,
    truncated: false,
    modifiedAt: null,
  });
});
