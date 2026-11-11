import test from "node:test";
import assert from "node:assert/strict";
import {
  DOCKED_CONTENT_MIN,
  DOCKED_PANEL_WIDTH,
  clampWidth,
  readStoredWidth,
  storeWidth,
  widthBounds,
} from "../../web/components/docked-panel-width.js";

test("the panel never gets narrower than its default and leaves the content room", () => {
  assert.deepEqual(widthBounds(1400), {
    min: DOCKED_PANEL_WIDTH,
    max: 1400 - DOCKED_CONTENT_MIN,
  });
  // Too narrow a parent: the default width stays, as before resizing existed.
  assert.deepEqual(widthBounds(500), {
    min: DOCKED_PANEL_WIDTH,
    max: DOCKED_PANEL_WIDTH,
  });
  assert.deepEqual(widthBounds(null), {
    min: DOCKED_PANEL_WIDTH,
    max: DOCKED_PANEL_WIDTH,
  });
  const bounds = widthBounds(1400);
  assert.equal(clampWidth(100, bounds), DOCKED_PANEL_WIDTH);
  assert.equal(clampWidth(5000, bounds), bounds.max);
  assert.equal(clampWidth(600.4, bounds), 600);
});

function withStorage(storage, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => {
      if (storage instanceof Error) throw storage;
      return storage;
    },
  });
  try {
    run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
}

test("the width is remembered per key and forgotten on reset", () => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  withStorage(storage, () => {
    assert.equal(readStoredWidth("pinboard"), null);
    storeWidth("pinboard", 612.6);
    assert.equal(readStoredWidth("pinboard"), 613);
    assert.equal(readStoredWidth("other"), null);
    storeWidth("pinboard", null);
    assert.equal(readStoredWidth("pinboard"), null);
    data.set("agentpier-docked-panel-width:pinboard", "nonsense");
    assert.equal(readStoredWidth("pinboard"), null);
  });
});

test("blocked storage leaves the default width", () => {
  withStorage(new Error("SecurityError"), () => {
    assert.equal(readStoredWidth("pinboard"), null);
    assert.doesNotThrow(() => storeWidth("pinboard", 500));
    assert.doesNotThrow(() => storeWidth("pinboard", null));
  });
  withStorage(undefined, () => {
    assert.equal(readStoredWidth("pinboard"), null);
    assert.doesNotThrow(() => storeWidth("pinboard", 500));
  });
});
