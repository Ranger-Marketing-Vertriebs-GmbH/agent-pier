import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SAVE_BUFFER,
  SAVE_PENDING_EVENT,
  appleStandalone,
  saveUrl,
} from "../../web/lib/standalone.js";
import { downloadName } from "../../web/lib/download-name.js";
import { downloadName as artifactName } from "../../web/features/artifacts/artifact-download.js";

// A browser environment for lib/standalone.js: display mode, platform, the share
// sheet and fetch, all recorded.
function browser(
  t,
  { standalone = true, ios = false, ipad = false, android = false } = {},
) {
  const saved = Object.fromEntries(
    ["window", "navigator", "fetch", "matchMedia"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  const state = { opened: [], shared: [], requests: [], events: [], share: null };
  const target = new EventTarget();
  target.open = (url) => state.opened.push(url);
  target.addEventListener(SAVE_PENDING_EVENT, (event) => state.events.push(event.detail));
  const navigator = {
    platform: ipad ? "MacIntel" : ios ? "iPhone" : android ? "Linux armv8l" : "MacIntel",
    maxTouchPoints: ipad || ios || android ? 5 : 0,
    userAgent: android ? "Mozilla/5.0 (Linux; Android 15)" : "Mozilla/5.0",
    ...(ios ? { standalone } : {}),
    canShare: (data) => Array.isArray(data?.files),
    share: async ({ files }) => {
      if (state.share) return state.share(files);
      state.shared.push(...files.map((file) => file.name));
    },
  };
  for (const [key, value] of Object.entries({
    window: target,
    navigator,
    matchMedia: (query) => ({ matches: standalone && query.includes("standalone") }),
    fetch: async (url, init = {}) => {
      state.requests.push([init.method || "GET", url]);
      const size = state.size ?? 4;
      if (state.status) return new Response("", { status: state.status });
      return new Response(init.method === "HEAD" ? null : "data", {
        headers: { "content-length": String(size), "content-type": "application/pdf" },
      });
    },
  }))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return state;
}

test("only an installed app on an Apple touch device takes the share-sheet path", (t) => {
  browser(t, { ios: true });
  assert.equal(appleStandalone(), true);
});
test("an iPad home-screen app counts, a desktop or Android installed app does not", (t) => {
  browser(t, { ipad: true });
  assert.equal(appleStandalone(), true);
});
test("an Android installed app keeps plain downloads", (t) => {
  browser(t, { android: true });
  assert.equal(appleStandalone(), false);
});
test("a desktop installed app keeps plain downloads", (t) => {
  browser(t);
  assert.equal(appleStandalone(), false);
});
test("a browser tab on an iPhone keeps plain downloads", (t) => {
  browser(t, { ios: true, standalone: false });
  assert.equal(appleStandalone(), false);
});

test("a small file goes to the share sheet after its size is known", async (t) => {
  const state = browser(t, { ios: true });
  assert.equal(await saveUrl("/api/files/report.pdf", "report.pdf"), "shared");
  assert.deepEqual(state.shared, ["report.pdf"]);
  assert.deepEqual(state.requests, [
    ["HEAD", "/api/files/report.pdf"],
    ["GET", "/api/files/report.pdf"],
  ]);
});

test("a large or unsized file is never buffered: it opens outside the app", async (t) => {
  const state = browser(t, { ios: true });
  state.size = MAX_SAVE_BUFFER + 1;
  assert.equal(await saveUrl("/api/backup", "backup.tar"), "opened");
  assert.deepEqual(state.opened, ["/api/backup"]);
  assert.deepEqual(state.requests, [["HEAD", "/api/backup"]]);
});

test("a share sheet refused for lost activation waits for one more tap", async (t) => {
  const state = browser(t, { ios: true });
  state.share = () => {
    throw Object.assign(new Error("activation"), { name: "NotAllowedError" });
  };
  assert.equal(await saveUrl("/api/files/a.pdf", "a.pdf"), "tap");
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].file.name, "a.pdf");
});

test("a refused response is an error, never a saved file", async (t) => {
  const state = browser(t, { ios: true });
  state.status = 404;
  await assert.rejects(saveUrl("/api/files/x", "x"));
  assert.deepEqual(state.shared, []);
});

test("one Content-Disposition parser serves every download", () => {
  assert.equal(artifactName, downloadName);
  assert.equal(
    downloadName("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"),
    "résumé.pdf",
  );
  assert.equal(downloadName('attachment; filename="plain.txt"'), "plain.txt");
  assert.equal(downloadName("attachment", "fallback"), "fallback");
});
