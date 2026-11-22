import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  harnessRuntimeDir,
  hermesEnvironment,
} from "../../server/features/assistants/runtimes/hermes/hermes-environment.js";

// browser_exec's engine (browser-harness) binds an AF_UNIX socket named after the
// session (up to 64 characters) in its runtime folder: on macOS the folder may take at
// most 30 bytes. Hermes v0.23 finds a short one itself; v0.22.5, the rollback target,
// binds below the agent's deep HOME and fails ("AF_UNIX path too long"). AgentPier
// names a short private folder per agent for both.

const agent = (home) => ({ home, hermesHome: `${home}/state`, tmp: `${home}/tmp` });
const runtime = { pythonPath: "/install/venv/bin/python" };

test("each agent's browser engine gets a short private runtime folder", (t) => {
  const home = `/data/very/deep/folder/${"x".repeat(80)}/assistants/hermes/home/ap-1`;
  const env = hermesEnvironment({ agent: agent(home), runtime, parent: {} });
  const dir = env.BH_RUNTIME_DIR;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(dir, harnessRuntimeDir(home));
  assert.match(dir, /^\/tmp\/aph-[0-9a-f]{12}$/);
  assert.ok(Buffer.byteLength(fs.realpathSync(dir)) <= 30, fs.realpathSync(dir));
  assert.equal(env.BH_RUNTIME_DIR_SHARED, "1");
  const stat = fs.lstatSync(dir);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o700);
  assert.equal(stat.uid, process.getuid());
  // Another agent gets another folder; the same one keeps its own.
  assert.notEqual(harnessRuntimeDir(`${home}-2`), dir);
  assert.equal(
    hermesEnvironment({ agent: agent(home), runtime, parent: {} }).BH_RUNTIME_DIR,
    dir,
  );
});

test("a folder someone else could reach is not used", (t) => {
  const home = `/data/agents/ap-${process.pid}-open`;
  const dir = harnessRuntimeDir(home);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = hermesEnvironment({ agent: agent(home), runtime, parent: {} });
  assert.equal(env.BH_RUNTIME_DIR, undefined);
  assert.equal(env.BH_RUNTIME_DIR_SHARED, undefined);
});
