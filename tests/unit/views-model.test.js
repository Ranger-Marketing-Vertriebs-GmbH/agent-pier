import test from "node:test";
import assert from "node:assert/strict";
import {
  adoptViews,
  normalizeViews,
  withPending,
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
