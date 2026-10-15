import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installNpm } from "../../server/features/mcp-packages/npm-package-install.js";
import { installPython } from "../../server/features/mcp-packages/python-package-install.js";
import {
  attach,
  deferred,
  harness,
  installEntries,
  source,
} from "../helpers/mcp-packages-harness.js";

/** An `npm ci` that waits for the job's abort and then fails like an aborted run. */
const heldCi = () => {
  const reached = deferred();
  const signals = [];
  const onCi = async ({ signal }) => {
    signals.push(signal);
    reached.resolve();
    await new Promise((resolve) => signal.addEventListener("abort", resolve));
    throw Object.assign(Error("The operation was aborted"), { name: "AbortError" });
  };
  return { reached, signals, onCi };
};

test("npm ci gets the job's signal; a cancel during it removes the stage", async (t) => {
  const { reached, signals, onCi } = heldCi();
  const { dataDir, service, records } = harness(t, { onCi });
  await attach(service);
  await reached.promise;
  assert.ok(signals[0] instanceof AbortSignal);
  records.remove("s1");
  assert.equal(await service.cancel("s1"), true);
  assert.equal(service.jobs.get("s1").state, "cancelled");
  await service.prune();
  assert.deepEqual(installEntries(dataDir), []);
});

test("a cancel during the command switch restores no record", async (t) => {
  const reached = deferred();
  const held = deferred();
  const { service, records } = harness(t, {
    beforeSwitch: async () => {
      reached.resolve();
      await held.promise;
      throw Object.assign(Error("gone"), { status: 404 });
    },
  });
  await attach(service);
  await reached.promise;
  records.remove("s1");
  const cancelled = service.cancel("s1");
  held.resolve();
  assert.equal(await cancelled, true);
  assert.equal(records.get("s1"), null);
});

test("close cancels a running install, removes its stage and restores no record", async (t) => {
  const { reached, signals, onCi } = heldCi();
  const { dataDir, service, records } = harness(t, { onCi });
  await attach(service);
  await reached.promise;
  const before = records.get("s1");
  await service.close();
  assert.equal(signals[0].aborted, true);
  assert.equal(service.jobs.get("s1").state, "cancelled");
  assert.equal(service.jobs.get("s1").code, "MCP_PACKAGE_CANCELLED");
  // The server still exists: its first install failed, as after a crash (the
  // "cancelled" message names a deleted server, so it is not stored).
  assert.deepEqual(records.get("s1"), {
    ...before,
    status: "failed",
    errorCode: "MCP_PACKAGE_INSTALL_FAILED",
  });
  await service.prune();
  assert.deepEqual(installEntries(dataDir), []);
});

test("close waits for a job that notices the cancel late only up to its bound", async (t) => {
  const held = deferred();
  const { service } = harness(t);
  // Like a toolchain download, this job ignores the signal until it ends.
  service.jobs.run("s9", { kind: "install" }, () => held.promise);
  const started = Date.now();
  await service.close({ waitMs: 50 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(service.jobs.get("s9").state, "running");
  held.resolve();
  await service.jobs.idle();
  assert.equal(service.jobs.get("s9").state, "done");
});

/** An installer process that fails once the job's signal aborted it. */
const abortedRun =
  (controller) =>
  async (_file, _args, { signal }) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    throw Object.assign(Error("aborted"), { stdout: "", stderr: "" });
  };
const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cancel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("an aborted npm or uv rejects as cancelled, not as a failed install", async (t) => {
  const npm = new AbortController();
  await assert.rejects(
    installNpm({
      directory: path.join(tempDir(t), "install"),
      manifestText: "{}",
      lockText: "{}",
      ref: { name: "x", version: "1.0.0" },
      node: { nodePath: "/node", npmCliPath: "/npm-cli.js" },
      registry: "http://registry.test",
      cacheDir: path.join(tempDir(t), "cache"),
      execute: abortedRun(npm),
      environment: {},
      signal: npm.signal,
    }),
    { code: "MCP_PACKAGE_CANCELLED" },
  );
  const uv = new AbortController();
  await assert.rejects(
    installPython({
      directory: path.join(tempDir(t), "install"),
      requirementsText: "x==1.0.0\n",
      lockText: "x==1.0.0\n",
      python: { uvPath: "/uv", pythonPath: "/python" },
      index: "http://index.test/simple",
      cacheDir: path.join(tempDir(t), "cache"),
      execute: abortedRun(uv),
      environment: {},
      signal: uv.signal,
    }),
    { code: "MCP_PACKAGE_CANCELLED" },
  );
});

test("a shutdown cancel during an update's failing switch restores the previous record", async (t) => {
  let hold = null;
  const { service, records, rows } = harness(t, {
    beforeSwitch: async () => {
      if (!hold) return;
      hold.reached.resolve();
      await hold.release.promise;
      throw Object.assign(Error("conflict"), { status: 500 });
    },
  });
  await attach(service);
  await service.jobs.idle();
  const ready = records.get("s1");
  const command = rows.get("s1").command;
  hold = { reached: deferred(), release: deferred() };
  service.reinstall("s1");
  await hold.reached.promise;
  const closed = service.close();
  hold.release.resolve();
  await closed;
  assert.equal(service.jobs.get("s1").state, "cancelled");
  assert.deepEqual(records.get("s1"), ready);
  assert.equal(rows.get("s1").command, command);
});

test("close stops a running preview's npm and waits for it", async (t) => {
  const reached = deferred();
  const signals = [];
  const { service } = harness(t, {
    onResolve: async ({ signal }) => {
      signals.push(signal);
      reached.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      throw Object.assign(Error("aborted"), { stdout: "", stderr: "" });
    },
  });
  const preview = service.preview(source);
  await reached.promise;
  assert.ok(signals[0] instanceof AbortSignal);
  await service.close();
  assert.equal(signals[0].aborted, true);
  await assert.rejects(preview, { code: "MCP_PACKAGE_CANCELLED" });
  assert.equal(service.previewRuns.size, 0);
});
