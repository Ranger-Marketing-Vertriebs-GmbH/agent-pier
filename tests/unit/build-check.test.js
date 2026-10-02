import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  UPDATE_EVENT,
  observeBuild,
  resetBuildCheck,
  updateDetected,
} from "../../web/lib/build-check.js";

const served = (id) =>
  new Response("{}", { headers: id ? { "x-agentpier-build": id } : {} });

test("a differing build header raises one update event", (t) => {
  const target = new EventTarget();
  globalThis.window = target;
  t.after(() => {
    delete globalThis.window;
    resetBuildCheck();
  });
  let events = 0;
  target.addEventListener(UPDATE_EVENT, () => events++);
  observeBuild(served("aaaaaaaaaaaaaaaa"), "aaaaaaaaaaaaaaaa");
  assert.equal(events, 0);
  observeBuild(served(""), "aaaaaaaaaaaaaaaa");
  observeBuild(served("bbbbbbbbbbbbbbbb"), "");
  assert.equal(events, 0);
  assert.equal(updateDetected(), false);
  observeBuild(served("bbbbbbbbbbbbbbbb"), "aaaaaaaaaaaaaaaa");
  observeBuild(served("cccccccccccccccc"), "aaaaaaaaaaaaaaaa");
  assert.equal(events, 1);
  assert.equal(updateDetected(), true);
});

test("every client fetch passes through the build check", () => {
  const root = path.resolve(import.meta.dirname, "../../web");
  const offenders = [];
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    if (!/\.(?:js|jsx)$/.test(entry) || entry.includes("i18n")) continue;
    const source = fs.readFileSync(path.join(root, entry), "utf8");
    if (/\bfetch\(/.test(source) && !source.includes("observeBuild"))
      offenders.push(entry);
  }
  assert.deepEqual(offenders, []);
});
