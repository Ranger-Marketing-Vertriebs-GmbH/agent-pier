import test from "node:test";
import assert from "node:assert/strict";
import {
  coveredViewport,
  installKeyboardInset,
  minimumInset,
  revealOffset,
} from "../../web/lib/keyboard-inset.js";

test("the keyboard covers what the visual viewport leaves below it", () => {
  assert.deepEqual(coveredViewport({ layoutHeight: 844, height: 500, offsetTop: 0 }), {
    inset: 344,
    top: 0,
    height: 500,
  });
  // iOS pans the visible area up to a focused field: less is covered below.
  assert.deepEqual(coveredViewport({ layoutHeight: 844, height: 500, offsetTop: 120 }), {
    inset: 224,
    top: 120,
    height: 500,
  });
});

test("no keyboard, rounding, pinch zoom and missing values cover nothing", () => {
  assert.equal(coveredViewport({ layoutHeight: 844, height: 844, offsetTop: 0 }), null);
  assert.equal(
    coveredViewport({ layoutHeight: 844, height: 844 - minimumInset + 1, offsetTop: 0 }),
    null,
  );
  assert.equal(
    coveredViewport({ layoutHeight: 844, height: 400, offsetTop: 100, scale: 2 }),
    null,
  );
  assert.equal(coveredViewport({ layoutHeight: 844, height: 0, offsetTop: 0 }), null);
  assert.equal(coveredViewport({ layoutHeight: NaN, height: 500, offsetTop: 0 }), null);
});

test("a hardware keyboard's accessory bar still counts", () => {
  assert.equal(
    coveredViewport({ layoutHeight: 1024, height: 969, offsetTop: 0 }).inset,
    55,
  );
});

test("revealing scrolls just enough and prefers the top of a tall target", () => {
  const view = { top: 100, bottom: 400 };
  assert.equal(revealOffset({ top: 150, bottom: 200 }, view), 0);
  assert.equal(revealOffset({ top: 420, bottom: 460 }, view), 60);
  assert.equal(revealOffset({ top: 60, bottom: 90 }, view), -40);
  // Taller than the view: its top lands at the top of the view.
  assert.equal(revealOffset({ top: 300, bottom: 800 }, view), 200);
  assert.equal(revealOffset({ top: 50, bottom: 800 }, view), -50);
});

function fakeWindow() {
  const listeners = new Map();
  const target = () => ({
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  });
  const properties = new Map();
  const attributes = new Set();
  const viewport = { ...target(), height: 844, offsetTop: 0, scale: 1 };
  const root = {
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
    },
    setAttribute: (name) => attributes.add(name),
    removeAttribute: (name) => attributes.delete(name),
  };
  const win = {
    ...target(),
    innerHeight: 844,
    visualViewport: viewport,
    document: { ...target(), documentElement: root, activeElement: null },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  };
  // Window and document share the map; the viewport's events are what matter here.
  return {
    win,
    viewport,
    properties,
    attributes,
    listeners,
    fire: () => listeners.get("resize")(),
  };
}

test("the root carries the variables only while a keyboard is open", () => {
  const { win, viewport, properties, attributes, fire } = fakeWindow();
  const stop = installKeyboardInset(win);
  assert.equal(properties.size, 0);
  viewport.height = 500;
  viewport.offsetTop = 20;
  fire();
  assert.deepEqual(Object.fromEntries(properties), {
    "--keyboard-inset": "324px",
    "--visual-viewport-top": "20px",
    "--visual-viewport-height": "500px",
  });
  assert.ok(attributes.has("data-keyboard-open"));
  viewport.height = 844;
  viewport.offsetTop = 0;
  fire();
  assert.equal(properties.size, 0);
  assert.equal(attributes.size, 0);
  viewport.height = 500;
  fire();
  stop();
  assert.equal(properties.size, 0);
  assert.equal(attributes.size, 0);
});

test("a keyboard closed in the background is noticed on return without a resize", () => {
  const { win, viewport, properties, attributes, listeners, fire } = fakeWindow();
  const stop = installKeyboardInset(win);
  viewport.height = 500;
  fire();
  assert.ok(attributes.has("data-keyboard-open"));
  // iOS reports the real viewport only after the app is back, without an event.
  viewport.height = 844;
  listeners.get("visibilitychange")();
  assert.equal(properties.size, 0);
  assert.equal(attributes.size, 0);
  viewport.height = 500;
  fire();
  viewport.height = 844;
  listeners.get("pageshow")();
  assert.equal(attributes.size, 0);
  stop();
  for (const type of ["pageshow", "focus", "visibilitychange"])
    assert.equal(listeners.has(type), false);
});
