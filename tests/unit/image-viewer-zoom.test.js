import test from "node:test";
import assert from "node:assert/strict";
import { clampView, pinchView, zoomAt } from "../../web/components/image-viewer-zoom.js";

const image = { width: 400, height: 300 };
const stage = { width: 400, height: 600 };

test("a pinch keeps the image point under the fingers and follows their midpoint", () => {
  const start = { scale: 1, x: 0, y: 0 };
  assert.deepEqual(pinchView(start, { x: 50, y: 40 }, { x: 50, y: 40 }, 2), {
    scale: 2,
    x: -50,
    y: -40,
  });
  // Moving fingers carry the image along.
  assert.deepEqual(pinchView(start, { x: 0, y: 0 }, { x: 30, y: 10 }, 1), {
    scale: 1,
    x: 30,
    y: 10,
  });
  // Past 4× the scale stops and the anchor still holds.
  assert.deepEqual(zoomAt({ scale: 2, x: -50, y: 0 }, 9, { x: 50, y: 0 }), {
    scale: 4,
    x: -150,
    y: 0,
  });
});

test("the view stays within 1–4× and never shows a gap beside a larger image", () => {
  assert.deepEqual(clampView({ scale: 0.5, x: 80, y: -80 }, image, stage), {
    scale: 1,
    x: 0,
    y: 0,
  });
  // At 2× the image is 800 × 600: 200 to spare sideways, none upright.
  assert.deepEqual(clampView({ scale: 2, x: 900, y: 900 }, image, stage), {
    scale: 2,
    x: 200,
    y: 0,
  });
  assert.deepEqual(clampView({ scale: 3, x: -900, y: -900 }, image, stage), {
    scale: 3,
    x: -400,
    y: -150,
  });
});
