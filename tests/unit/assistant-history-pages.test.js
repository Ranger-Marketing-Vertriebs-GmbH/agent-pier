import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  withLatest,
  withOlderPage,
} from "../../web/features/assistants/history-pages.js";

const m = (n, text = `m${n}`) => ({ id: `m${n}`, role: "assistant", text });
const ids = (history) => history.messages.map((row) => row.id);
const window = (from, to, nextBefore = from > 0 ? "x" : null) => ({
  messages: Array.from({ length: to - from }, (_, i) => m(from + i)),
  requests: [],
  nextBefore,
});

test("a refreshed latest window keeps the older page loaded above it", () => {
  const loaded = withOlderPage(window(4, 6, "2"), window(0, 4, null));
  assert.deepEqual(ids(loaded), ["m0", "m1", "m2", "m3", "m4", "m5"]);
  // The turn goes on: the newest window gains a reply and drops its oldest row.
  const next = withLatest(loaded, window(5, 7, "3"));
  assert.deepEqual(ids(next), ["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
  assert.equal(next.nextBefore, null);
  // And stays there across further refreshes.
  assert.deepEqual(ids(withLatest(next, window(5, 7, "3"))), ids(next));
});

test("the latest window's copy of a row wins", () => {
  const loaded = withOlderPage(window(2, 4, "2"), window(0, 2, "4"));
  const edited = { ...window(2, 4, "2"), messages: [m(2, "edited"), m(3)] };
  const next = withLatest(loaded, edited);
  assert.equal(next.messages.find((row) => row.id === "m2").text, "edited");
  assert.equal(next.nextBefore, "4");
});

test("without older pages, or without overlap, the latest window stands alone", () => {
  const latest = window(4, 6, "2");
  assert.equal(withLatest(latest, window(5, 7, "2")).messages.length, 2);
  const loaded = withOlderPage(latest, window(0, 4, null));
  // A window that no longer touches what is shown would leave a gap.
  assert.deepEqual(ids(withLatest(loaded, window(9, 11, "9"))), ["m9", "m10"]);
  // A window that reaches the start is the whole conversation.
  assert.deepEqual(ids(withLatest(loaded, window(0, 3, null))), ["m0", "m1", "m2"]);
});

test("merged windows never repeat a row and keep the newest rows last", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 30 }),
      fc.integer({ min: 1, max: 30 }),
      fc.integer({ min: 0, max: 10 }),
      (olderCount, size, grown) => {
        const total = olderCount + size;
        const loaded = withOlderPage(
          window(olderCount, total, "o"),
          window(0, olderCount, null),
        );
        const end = total + grown;
        const next = withLatest(loaded, window(Math.max(1, end - size), end, "n"));
        const shown = ids(next);
        assert.equal(new Set(shown).size, shown.length);
        assert.equal(shown.at(-1), `m${end - 1}`);
        if (grown < size) assert.deepEqual(shown, ids(window(0, end)));
      },
    ),
  );
});
