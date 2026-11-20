import { test } from "node:test";
import assert from "node:assert/strict";
import { menuPlacement } from "../../web/components/anchored-select-placement.js";

const origin = { top: 0, left: 0 };
const field = (top) => ({ top, bottom: top + 40, left: 20, width: 300 });

test("a menu opens below its field when there is room", () => {
  assert.deepEqual(menuPlacement({ field: field(100), origin, top: 8, bottom: 992 }), {
    above: false,
    height: 260,
    top: 146,
    left: 20,
    width: 300,
  });
});

test("a menu flips above its field when only there is room", () => {
  const placement = menuPlacement({ field: field(800), origin, top: 8, bottom: 900 });
  assert.equal(placement.above, true);
  assert.equal(placement.top, 794);
  assert.equal(placement.height, 260);
});

test("the room is measured to the bound, and positions follow the layer and zoom", () => {
  const placement = menuPlacement({
    field: field(100),
    origin: { top: 10, left: 10 },
    scale: 2,
    top: 8,
    bottom: 300,
  });
  assert.equal(placement.above, false);
  assert.equal(placement.height, (300 - 140 - 6) / 2);
  assert.equal(placement.top, (146 - 10) / 2);
  assert.equal(placement.left, 5);
});
