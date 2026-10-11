import test from "node:test";
import assert from "node:assert/strict";
import { detectBrowser } from "../../server/features/assistants/browser-detection.js";

test("the first installed Chromium-based browser is chosen per platform", () => {
  const mac = new Set(["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]);
  assert.deepEqual(
    detectBrowser({ platform: "darwin", exists: (p) => mac.has(p), home: "/Users/x" }),
    {
      available: true,
      name: "Brave",
      executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    },
  );
  assert.deepEqual(
    detectBrowser({
      platform: "linux",
      exists: (p) => p === "/usr/bin/chromium",
      home: "/home/x",
    }).name,
    "Chromium",
  );
  assert.deepEqual(
    detectBrowser({ platform: "darwin", exists: () => false, home: "/Users/x" }),
    { available: false },
  );
});

test("an unsupported platform reports no browser", () => {
  assert.deepEqual(
    detectBrowser({ platform: "win32", exists: () => true, home: "C:\\Users\\x" }),
    { available: false },
  );
});
