import test from "node:test";
import assert from "node:assert/strict";
import {
  edgeClassNames,
  revealScrollLeft,
  scrollEdges,
} from "../../web/components/scroll-fade.js";

test("edges report which side still has hidden content", () => {
  assert.deepEqual(scrollEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 }), {
    left: false,
    right: false,
  });
  assert.deepEqual(scrollEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 500 }), {
    left: false,
    right: true,
  });
  assert.deepEqual(scrollEdges({ scrollLeft: 200, clientWidth: 300, scrollWidth: 500 }), {
    left: true,
    right: false,
  });
  assert.deepEqual(
    scrollEdges({ scrollLeft: 0.5, clientWidth: 300, scrollWidth: 300.5 }),
    {
      left: false,
      right: false,
    },
  );
});

test("edge class names join the base classes with the hidden sides", () => {
  assert.equal(edgeClassNames({ left: false, right: false }, "row"), "row");
  assert.equal(
    edgeClassNames({ left: true, right: true }, "row", "scroll-fade"),
    "row scroll-fade can-scroll-left can-scroll-right",
  );
  assert.equal(edgeClassNames({ left: false, right: true }), "can-scroll-right");
});

test("the active item is revealed with a 48px margin and clamped", () => {
  const row = { clientWidth: 300, scrollWidth: 800 };
  assert.equal(
    revealScrollLeft({ ...row, itemLeft: 100, itemWidth: 80, scrollLeft: 0 }),
    null,
  );
  assert.equal(
    revealScrollLeft({ ...row, itemLeft: 400, itemWidth: 80, scrollLeft: 0 }),
    400 + 80 + 48 - 300,
  );
  assert.equal(
    revealScrollLeft({ ...row, itemLeft: 100, itemWidth: 80, scrollLeft: 300 }),
    52,
  );
  assert.equal(
    revealScrollLeft({ ...row, itemLeft: 20, itemWidth: 80, scrollLeft: 300 }),
    0,
  );
  assert.equal(
    revealScrollLeft({ ...row, itemLeft: 720, itemWidth: 80, scrollLeft: 0 }),
    500,
  );
});
