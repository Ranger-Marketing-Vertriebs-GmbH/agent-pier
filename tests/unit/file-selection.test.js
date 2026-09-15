import test from "node:test";
import assert from "node:assert/strict";
import {
  selectionChange,
  reconcileSelection,
} from "../../web/features/files/useFileSelection.js";
import { retainedClipboard } from "../../web/features/files/useFileClipboard.js";

const entries = ["a", "b", "c", "d"].map((path) => ({ path, revision: `e1:${path}` }));
test("selection supports contiguous range, toggles and revision-aware reload", () => {
  let state = selectionChange({ selected: [], anchor: null }, entries, "select", "b");
  state = selectionChange(state, entries, "range", "d");
  assert.deepEqual(
    state.selected.map((item) => item.path),
    ["b", "c", "d"],
  );
  state = selectionChange(state, entries, "toggle", "c");
  assert.deepEqual(
    state.selected.map((item) => item.path),
    ["b", "d"],
  );
  state = reconcileSelection(state, [entries[1], { ...entries[3], revision: "changed" }]);
  assert.deepEqual(
    state.selected.map((item) => item.path),
    ["b"],
  );
});
test("Cut retains failures, published outputs and unproven removals; children do not clear parents", () => {
  const items = ["a", "dir", "failed", "pending"].map((path) => ({
    path,
    revision: "e1:r",
  }));
  assert.deepEqual(
    retainedClipboard(items, [
      { source: "a", sourceRemoved: true },
      { source: "dir/child", sourceRemoved: true },
      { source: "dir", outputPublished: true, sourceRemoved: false },
      { source: "failed", status: "failed" },
      { source: "pending", sourceRemovalPending: true },
    ]).map((item) => item.path),
    ["dir", "failed", "pending"],
  );
});

test("purge envelopes cover a frozen selection in bounded ordered batches", async () => {
  const { purgeBatches, bytes } =
    await import("../../web/features/files/file-action-utils.js");
  const items = Array.from({ length: 1200 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    revision: `t1:${"a".repeat(64)}`,
  }));
  const batches = purgeBatches(items);
  assert.ok(batches.length > 1);
  assert.deepEqual(
    batches.flatMap((batch) => batch.sources),
    items.map((item) => item.id),
  );
  for (const batch of batches) {
    assert.ok(bytes(batch) <= 64 * 1024);
    assert.deepEqual(
      batch.options.confirmation.map((item) => item.id),
      batch.sources,
    );
  }
  assert.equal(new Set(batches.map((batch) => batch.requestId)).size, batches.length);
  items.push({ id: "later", revision: "later" });
  assert.equal(batches.flatMap((batch) => batch.sources).includes("later"), false);
});
