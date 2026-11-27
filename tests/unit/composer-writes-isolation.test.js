import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { composerWritesDirectory } from "../helpers/composer-writes.js";
import {
  defaultWritesDirectory,
  withOrderLock,
} from "../../server/features/cli-profiles/skills/agentpier-composer/scripts/order-progress.mjs";

// The Composer writer lock is one per user on purpose: the server and the helper in
// every CLI session take the same one. A test run must never hold it, or a running
// AgentPier on this machine waits for the tests.

test("a test process has a writer lock folder of its own", () => {
  const folder = composerWritesDirectory();
  assert.ok(path.isAbsolute(folder));
  assert.notEqual(fs.realpathSync(folder), defaultWritesDirectory());
  assert.equal(fs.statSync(folder).mode & 0o077, 0, "private to the user");
  assert.equal(
    withOrderLock(() => "done"),
    "done",
  );
  assert.ok(fs.existsSync(path.join(folder, "writer.sqlite")));
});

test("without that folder a test is refused instead of taking the shared lock", (t) => {
  const folder = process.env.AGENTPIER_COMPOSER_WRITES_DIR;
  t.after(() => (process.env.AGENTPIER_COMPOSER_WRITES_DIR = folder));
  delete process.env.AGENTPIER_COMPOSER_WRITES_DIR;
  assert.ok(process.env.NODE_TEST_CONTEXT, "Node's test runner marks its processes");
  let ran = false;
  assert.throws(() => withOrderLock(() => (ran = true)), { code: "ORDER_TEST_LOCK" });
  assert.equal(ran, false);
});

test("the folder must be an absolute path and private", (t) => {
  const folder = process.env.AGENTPIER_COMPOSER_WRITES_DIR;
  t.after(() => (process.env.AGENTPIER_COMPOSER_WRITES_DIR = folder));
  process.env.AGENTPIER_COMPOSER_WRITES_DIR = "relative/folder";
  assert.throws(() => withOrderLock(() => {}), { code: "ORDER_UNSAFE" });
  const open = path.join(folder, "open");
  fs.mkdirSync(open, { mode: 0o755 });
  fs.chmodSync(open, 0o755);
  process.env.AGENTPIER_COMPOSER_WRITES_DIR = open;
  assert.throws(() => withOrderLock(() => {}), { code: "ORDER_UNSAFE" });
});
