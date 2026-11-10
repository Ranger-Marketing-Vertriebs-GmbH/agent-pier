import test from "node:test";
import assert from "node:assert/strict";
import {
  DISMISS_DISTANCE,
  FLICK_VELOCITY,
  sheetDragOffset,
  sheetDragVelocity,
  shouldDismissSheet,
} from "../../web/components/useSheetDrag.js";

test("the sheet follows a downward drag and never rises above its place", () => {
  assert.equal(sheetDragOffset(42), 42);
  assert.equal(sheetDragOffset(0), 0);
  assert.equal(sheetDragOffset(-30), 0);
});

test("a slow drag dismisses past 30% of the sheet or 120px, whichever is shorter", () => {
  // A short sheet: 30% of 300px is 90px.
  assert.equal(shouldDismissSheet({ offset: 89, height: 300, velocity: 0 }), false);
  assert.equal(shouldDismissSheet({ offset: 90, height: 300, velocity: 0 }), true);
  // A tall sheet: 120px is less than 30% of 700px.
  assert.equal(
    shouldDismissSheet({ offset: DISMISS_DISTANCE - 1, height: 700, velocity: 0.1 }),
    false,
  );
  assert.equal(
    shouldDismissSheet({ offset: DISMISS_DISTANCE, height: 700, velocity: 0.1 }),
    true,
  );
});

test("a fast downward flick dismisses after a short drag", () => {
  assert.equal(
    shouldDismissSheet({ offset: 30, height: 700, velocity: FLICK_VELOCITY }),
    true,
  );
  // A tap-sized movement is no flick.
  assert.equal(shouldDismissSheet({ offset: 5, height: 700, velocity: 2 }), false);
  assert.equal(shouldDismissSheet({ offset: 0, height: 700, velocity: 2 }), false);
});

test("a flick back up keeps the sheet open however far it was dragged", () => {
  assert.equal(
    shouldDismissSheet({ offset: 300, height: 700, velocity: -FLICK_VELOCITY }),
    false,
  );
  assert.equal(shouldDismissSheet({ offset: 300, height: 700, velocity: -0.2 }), true);
});

test("the release velocity covers only the last 100 ms of the drag", () => {
  assert.equal(sheetDragVelocity([]), 0);
  assert.equal(sheetDragVelocity([{ y: 10, t: 0 }]), 0);
  assert.equal(
    sheetDragVelocity([
      { y: 0, t: 0 },
      { y: 100, t: 100 },
    ]),
    1,
  );
  // A long slow drag that ends in a quick flick reads as the flick.
  assert.equal(
    sheetDragVelocity([
      { y: 0, t: 0 },
      { y: 20, t: 400 },
      { y: 30, t: 450 },
      { y: 80, t: 500 },
    ]),
    0.6,
  );
  // A drag that stopped before release has no velocity left.
  assert.equal(
    sheetDragVelocity([
      { y: 0, t: 0 },
      { y: 200, t: 50 },
      { y: 200, t: 300 },
    ]),
    0,
  );
});

test("a sheet that cannot close stretches like a rubber band, never past 60px", () => {
  const resist = { resist: true };
  assert.equal(sheetDragOffset(-20, resist), 0);
  assert.equal(sheetDragOffset(60, resist), 30);
  assert.ok(sheetDragOffset(30, resist) < 30);
  assert.ok(sheetDragOffset(400, resist) > sheetDragOffset(200, resist));
  assert.ok(sheetDragOffset(10000, resist) < 60);
});
