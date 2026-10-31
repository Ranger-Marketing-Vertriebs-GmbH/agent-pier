import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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

// Client modules under webRoot that fetch without the build check. The scan stays in
// the checkout this test belongs to: never a sibling or nested worktree.
function unobservedFetches(webRoot) {
  const offenders = [];
  for (const entry of fs.readdirSync(webRoot, { recursive: true })) {
    if (!/\.(?:js|jsx)$/.test(entry) || entry.includes("i18n")) continue;
    const source = fs.readFileSync(path.join(webRoot, entry), "utf8");
    if (/\bfetch\(/.test(source) && !source.includes("observeBuild"))
      offenders.push(entry);
  }
  return offenders;
}

test("every client fetch passes through the build check", () => {
  assert.deepEqual(unobservedFetches(path.resolve(import.meta.dirname, "../../web")), []);
});

test("the fetch scan ignores a nested worktree beside its own web folder", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-build-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, body) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  };
  write("web/features/ok.js", 'observeBuild(await fetch("/api"));\n');
  write(".worktrees/x/web/features/foo.js", 'await fetch("/api");\n');
  assert.deepEqual(unobservedFetches(path.join(root, "web")), []);
  write("web/features/foo.js", 'await fetch("/api");\n');
  assert.deepEqual(unobservedFetches(path.join(root, "web")), [
    path.join("features", "foo.js"),
  ]);
});
