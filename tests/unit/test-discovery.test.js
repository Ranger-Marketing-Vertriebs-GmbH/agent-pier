import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverTestFiles } from "../../scripts/test-runner.mjs";

function checkout(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-test-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of files) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), "");
  }
  return root;
}

const relative = (root, files) => files.map((file) => path.relative(root, file));

test("discovery from a checkout with nested worktrees collects only its own tests", (t) => {
  const root = checkout(t, [
    "tests/unit/a.test.js",
    "tests/unit/nested/b.test.js",
    "tests/integration/c.test.js",
    "tests/browser/d.spec.js",
    "tests/helpers/e.js",
    ".worktrees/x/tests/unit/foreign.test.js",
    "tests/.worktrees/y/tests/unit/foreign.test.js",
    "tests/unit/node_modules/pkg/dependency.test.js",
    "tests/unit/dist/built.test.js",
  ]);
  assert.deepEqual(relative(root, discoverTestFiles(root)), [
    "tests/integration/c.test.js",
    "tests/unit/a.test.js",
    "tests/unit/nested/b.test.js",
  ]);
  assert.deepEqual(relative(root, discoverTestFiles(root, "unit")), [
    "tests/unit/a.test.js",
    "tests/unit/nested/b.test.js",
  ]);
  assert.deepEqual(discoverTestFiles(root, "matrix"), []);
});

test("discovery does not follow a symbolic link out of the checkout", (t) => {
  const root = checkout(t, ["tests/unit/a.test.js", "sibling/tests/unit/z.test.js"]);
  fs.symlinkSync(
    path.join(root, "sibling/tests/unit"),
    path.join(root, "tests/unit/link"),
  );
  fs.symlinkSync(
    path.join(root, "sibling/tests/unit/z.test.js"),
    path.join(root, "tests/unit/z.test.js"),
  );
  assert.deepEqual(relative(root, discoverTestFiles(root)), ["tests/unit/a.test.js"]);
});
