import test from "node:test";
import assert from "node:assert/strict";
import {
  browserCandidates,
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

test("on Linux an app that does not start is passed over for the next one", () => {
  const installed = new Set(["/usr/bin/chromium", "/usr/bin/google-chrome"]);
  const base = {
    platform: "linux",
    exists: (p) => installed.has(p),
    home: "/home/x",
    env: { DISPLAY: ":0" },
  };
  // Not yet checked: the separate agent app stays first.
  assert.equal(detectBrowser(base).executablePath, "/usr/bin/chromium");
  const found = detectBrowser({
    ...base,
    launch: (p) =>
      p === "/usr/bin/chromium" ? { ok: false, problem: "sandbox" } : { ok: true },
  });
  assert.deepEqual(found, {
    available: true,
    name: "Chrome",
    executablePath: "/usr/bin/google-chrome",
    // Chrome is the owner's browser: no visible window with it.
    visible: { available: false, reason: "noApp" },
    launch: { name: "Chromium", problem: "sandbox", usable: true },
  });
});

test("when no app starts the first stays chosen and the problem is reported", () => {
  const found = detectBrowser({
    platform: "linux",
    exists: (p) => p === "/usr/bin/chromium",
    home: "/home/x",
    env: {},
    launch: () => ({ ok: false, problem: "crashed" }),
  });
  assert.equal(found.available, true);
  assert.equal(found.executablePath, "/usr/bin/chromium");
  assert.deepEqual(found.launch, { name: "Chromium", problem: "crashed", usable: false });
});

test("a failure of a later app than the chosen one is not reported", () => {
  const installed = new Set(["/usr/bin/chromium", "/usr/bin/google-chrome"]);
  const found = detectBrowser({
    platform: "linux",
    exists: (p) => installed.has(p),
    home: "/home/x",
    env: {},
    launch: (p) =>
      p === "/usr/bin/google-chrome" ? { ok: false, problem: "missing" } : { ok: true },
  });
  assert.equal(found.executablePath, "/usr/bin/chromium");
  assert.equal(found.launch, undefined);
});

test("the launch check gets every installed app once, in the detection order", () => {
  const installed = new Set([
    "/managed/chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/brave-browser",
  ]);
  assert.deepEqual(
    browserCandidates({
      platform: "linux",
      exists: (p) => installed.has(p),
      home: "/home/x",
      managed: "/managed/chrome",
    }),
    [
      "/managed/chrome",
      "/usr/bin/brave-browser",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
    ],
  );
  const managed = detectBrowser({
    platform: "linux",
    exists: (p) => installed.has(p),
    home: "/home/x",
    env: { DISPLAY: ":0" },
    managed: "/managed/chrome",
    launch: (p) =>
      p === "/managed/chrome" ? { ok: false, problem: "sandbox" } : undefined,
  });
  assert.equal(managed.executablePath, "/usr/bin/brave-browser");
  assert.equal(managed.managed, undefined);
  assert.deepEqual(managed.visible, { available: true });
  assert.equal(managed.launch.name, "Chrome for Testing");
});
