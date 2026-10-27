import test from "node:test";
import assert from "node:assert/strict";
import {
  clampView,
  doubleTapView,
  pinchView,
  scaleLimit,
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

test("a long screenshot may zoom to twice its fit-to-width size, others to 4×", () => {
  // 188 wide in a 1280 stage: fit to width is 1280 / 188 ≈ 6.8×, so the limit ≈ 13.6×.
  assert.equal(scaleLimit(tall, desk), (2 * 1280) / 188);
  const deep = clampView({ scale: 99, x: 0, y: -1e6 }, tall, desk);
  assert.equal(deep.scale, (2 * 1280) / 188);
  // At its limit it is 2560 wide: 640 to spare each side, and its bottom reachable.
  assert.equal(clampView({ scale: 99, x: 1e6, y: 0 }, tall, desk).x, 640);
  assert.equal(edges(deep, tall).bottom, 0);
  // A normal image keeps the 4× limit, and so does pinchView without one.
  assert.equal(scaleLimit(image, stage), 4);
  assert.equal(clampView({ scale: 9, x: 0, y: 0 }, image, stage).scale, 4);
  assert.equal(
    pinchView({ scale: 1, x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 9).scale,
    4,
  );
  assert.equal(
    pinchView({ scale: 1, x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 9, 13).scale,
    9,
  );
});

test("a double tap fills the width with a long screenshot from its top", () => {
  const rest = { scale: 1, x: 0, y: 0 };
  const view = doubleTapView(rest, { x: 40, y: 300 }, tall, desk);
  const scale = 1280 / 188;
  assert.deepEqual(view, { scale, x: 0, y: (940 * scale - 940) / 2 });
  assert.equal(clampView(view, tall, desk).y, view.y);
  assert.equal(edges(view, tall).top, 0);
  // A normal image doubles around the tap, and any zoomed image goes back to rest.
  assert.deepEqual(doubleTapView(rest, { x: 50, y: 40 }, image, stage), {
    scale: 2,
    x: -50,
    y: -40,
  });
  assert.deepEqual(doubleTapView(view, { x: 0, y: 0 }, tall, desk), rest);
  // Half the stage's width or more is no strip.
  const half = { width: 640, height: 940 };
  assert.equal(doubleTapView(rest, { x: 0, y: 0 }, half, desk).scale, 2);
});
