import test from "node:test";
import assert from "node:assert/strict";
import {
  adoptViews,
  normalizeViews,
  withPending,
  unreadViews,
  withWrite,
} from "../../web/features/views/views-model.js";

test("normalizeViews reads anything without a views list as empty", () => {
  assert.deepEqual(normalizeViews({}), { version: 0, views: [] });
  assert.deepEqual(normalizeViews(null), { version: 0, views: [] });
  assert.deepEqual(normalizeViews({ views: "x", version: 4 }), { version: 0, views: [] });
  assert.deepEqual(normalizeViews({ views: [] }), { version: 0, views: [] });
  assert.deepEqual(normalizeViews({ version: 2, views: [{ id: "v_a" }, null] }), {
    version: 2,
    views: [{ id: "v_a" }],
  });
});

test("adoptViews ignores a frame older than the last write", () => {
  const a = { id: "v_a", revision: 2, name: "new" },
    b = { id: "v_b", revision: 1, name: "B" };
  const written = withWrite({ version: 3, views: [b] }, { version: 4, view: a });
  assert.deepEqual(written, { version: 4, views: [b, a] });
  assert.equal(adoptViews(written, { version: 3, views: [b] }), written);
  assert.deepEqual(adoptViews(written, { version: 5, views: [a] }), {
    version: 5,
    views: [a],
  });
  assert.deepEqual(withWrite(written, { version: 5, removedId: "v_b" }), {
    version: 5,
    views: [a],
  });
});

test("withWrite replaces a view in place", () => {
  const a = { id: "v_a", name: "A" },
    b = { id: "v_b", name: "B" };
  assert.deepEqual(
    withWrite({ version: 1, views: [a, b] }, { version: 2, view: { ...a, name: "A2" } }),
    {
      version: 2,
      views: [{ id: "v_a", name: "A2" }, b],
    },
  );
});

test("withPending applies optimistic edits over the confirmed document", () => {
  const a = { id: "v_a", name: "A", layout: null };
  const document = { version: 1, views: [a] };
  const shown = withPending(document, [
    { id: "v_a", patch: { name: "X" } },
    { id: "v_gone", patch: { name: "Y" } },
  ]);
  assert.deepEqual(shown, {
    version: 1,
    views: [{ id: "v_a", name: "X", layout: null }],
  });
  assert.equal(withPending(document, []), document);
});

test("adoptViews follows the epoch: a restarted server's document wins", () => {
  const a = { id: "v_a", name: "A" },
    b = { id: "v_b", name: "B" };
  const current = withWrite(
    { epoch: "e1", version: 7, views: [a] },
    { epoch: "e1", version: 8, view: b },
  );
  assert.deepEqual(current, { epoch: "e1", version: 8, views: [a, b] });
  assert.equal(adoptViews(current, { epoch: "e1", version: 6, views: [a] }), current);
  const restored = { epoch: "e2", version: 3, views: [a] };
  assert.equal(adoptViews(current, restored), restored);
  assert.deepEqual(normalizeViews({ epoch: "e2", version: 3, views: [] }), {
    epoch: "e2",
    version: 3,
    views: [],
  });
  assert.deepEqual(withWrite(restored, { epoch: "e2", version: 4, removedId: "v_a" }), {
    epoch: "e2",
    version: 4,
    views: [],
  });
});

test("a write answered before the first read never hides the read", () => {
  const a = { id: "v_a", name: "A" },
    b = { id: "v_b", name: "B" };
  const written = withWrite(unreadViews, { epoch: "e1", version: 2, view: a });
  assert.deepEqual(written.views, [a]);
  const read = { epoch: "e1", version: 1, views: [a, b] };
  assert.equal(adoptViews(written, read), read);
  // Once read, the usual order applies again.
  const after = withWrite(read, { epoch: "e1", version: 3, view: a });
  assert.equal(adoptViews(after, read), after);
});
