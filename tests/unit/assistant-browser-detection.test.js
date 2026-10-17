import test from "node:test";
import assert from "node:assert/strict";
import {
  detectBrowser,
  hasDisplay,
} from "../../server/features/assistants/browser-detection.js";

const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("the first installed Chromium-based browser is chosen per platform", () => {
  assert.deepEqual(
    detectBrowser({ platform: "darwin", exists: (p) => p === brave, home: "/Users/x" }),
    {
      available: true,
      name: "Brave",
      executablePath: brave,
      visible: { available: true },
    },
  );
  assert.deepEqual(
    detectBrowser({
      platform: "linux",
      exists: (p) => p === "/usr/bin/chromium",
      home: "/home/x",
      env: { DISPLAY: ":0" },
    }).name,
    "Chromium",
  );
  assert.deepEqual(
    detectBrowser({ platform: "darwin", exists: () => false, home: "/Users/x" }),
    { available: false, visible: { available: false, reason: "noApp" } },
  );
});

test("a separate agent browser app wins over the owner's Chrome", () => {
  const both = new Set([chrome, brave]);
  const found = detectBrowser({
    platform: "darwin",
    exists: (p) => both.has(p),
    home: "/Users/x",
  });
  assert.equal(found.executablePath, brave);
  assert.deepEqual(found.visible, { available: true });
  const testing =
    "/Users/x/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  assert.equal(
    detectBrowser({
      platform: "darwin",
      exists: (p) => p === testing || p === chrome,
      home: "/Users/x",
    }).name,
    "Chrome for Testing",
  );
});

test("only the owner's Chrome stays headless: no visible window falls back to it", () => {
  const found = detectBrowser({
    platform: "darwin",
    exists: (p) => p === chrome,
    home: "/Users/x",
  });
  assert.equal(found.executablePath, chrome);
  assert.deepEqual(found.visible, { available: false, reason: "noApp" });
});

test("Linux needs a display for visible windows", () => {
  const exists = (p) => p === "/usr/bin/brave-browser";
  assert.deepEqual(
    detectBrowser({ platform: "linux", exists, home: "/home/x", env: {} }).visible,
    { available: false, reason: "noDisplay" },
  );
  assert.deepEqual(
    detectBrowser({ platform: "linux", exists, env: { WAYLAND_DISPLAY: "wayland-0" } })
      .visible,
    { available: true },
  );
  assert.equal(hasDisplay("darwin", {}), true);
  assert.equal(hasDisplay("linux", {}), false);
});

test("an unsupported platform reports no browser", () => {
  assert.deepEqual(
    detectBrowser({ platform: "win32", exists: () => true, home: "C:\\Users\\x" }),
    { available: false, visible: { available: false, reason: "noApp" } },
  );
});
