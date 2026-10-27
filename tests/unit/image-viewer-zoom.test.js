import test from "node:test";
import assert from "node:assert/strict";
import {
  clampView,
  pinchView,
  scrollView,
  zoomAt,
} from "../../web/components/image-viewer-zoom.js";

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

// A tall screenshot (800 × 4000) fitted into a 1280 × 940 stage is 188 × 940.
const desk = { width: 1280, height: 940 };
const tall = { width: 188, height: 940 };
// Its zoomed top edge sits at stage top, its bottom at the stage bottom: edge offsets of
// the drawn image from the stage's own edges.
const edges = (view, size) => ({
  top: view.y - (size.height * view.scale) / 2 + desk.height / 2,
  bottom: view.y + (size.height * view.scale) / 2 - desk.height / 2,
});

test("a zoomed tall image pans exactly to its top and bottom edges", () => {
  // At rest it fits: no room to pan either way.
  assert.deepEqual(clampView({ scale: 1, x: 50, y: 500 }, tall, desk), {
    scale: 1,
    x: 0,
    y: 0,
  });
  // At 4× it is 752 × 3760: narrower than the stage, 2820 taller.
  const down = clampView({ scale: 4, x: 0, y: -99999 }, tall, desk);
  assert.deepEqual(down, { scale: 4, x: 0, y: -1410 });
  assert.equal(edges(down, tall).bottom, 0);
  const up = clampView({ scale: 4, x: 300, y: 99999 }, tall, desk);
  assert.deepEqual(up, { scale: 4, x: 0, y: 1410 });
  assert.equal(edges(up, tall).top, 0);
});

test("a zoomed wide image still pans sideways only", () => {
  const wide = { width: 1280, height: 256 };
  assert.deepEqual(clampView({ scale: 3, x: -99999, y: -99999 }, wide, desk), {
    scale: 3,
    x: -1280,
    y: 0,
  });
});

test("a wheel scroll pans like a page: down shows the bottom, shift goes sideways", () => {
  const view = { scale: 2, x: 0, y: 0 };
  assert.deepEqual(scrollView(view, { deltaX: 0, deltaY: 120 }, desk), {
    scale: 2,
    x: 0,
    y: -120,
  });
  assert.deepEqual(scrollView(view, { deltaX: -30, deltaY: 10 }, desk), {
    scale: 2,
    x: 30,
    y: -10,
  });
  assert.deepEqual(scrollView(view, { deltaX: 0, deltaY: 3, shiftKey: true }, desk), {
    scale: 2,
    x: -3,
    y: 0,
  });
  // Lines and pages, as Firefox reports some wheels.
  assert.deepEqual(scrollView(view, { deltaX: 0, deltaY: 3, deltaMode: 1 }, desk), {
    scale: 2,
    x: 0,
    y: -48,
  });
  assert.deepEqual(scrollView(view, { deltaX: 0, deltaY: 1, deltaMode: 2 }, desk), {
    scale: 2,
    x: 0,
    y: -940,
  });
});
