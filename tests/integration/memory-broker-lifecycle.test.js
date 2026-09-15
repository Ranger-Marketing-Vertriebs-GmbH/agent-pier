import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { MemoryIntegration } from "../../server/features/memory/memory-integration.js";

test("failed socket permissions close the listener and owned database", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-memory-failed-"));
  const chmod = fs.chmodSync;
  t.mock.method(fs, "chmodSync", (file, mode) => {
    if (String(file).endsWith("/mcp.sock")) throw Error("fixture chmod failure");
    return chmod(file, mode);
  });
  const integration = new MemoryIntegration({ dataDir });
  t.after(async () => {
    t.mock.restoreAll();
    integration.broker.server?.closeAllConnections();
    integration.broker.server?.close();
    integration.memory.close();
    fs.rmSync(path.dirname(integration.broker.socketPath), {
      recursive: true,
      force: true,
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await assert.rejects(integration.ready, /fixture chmod failure/);
  assert.equal(integration.broker.server.listening, false);
  await integration.close();
  assert.equal(integration.memory.closed, true);
  assert.equal(fs.existsSync(integration.broker.socketPath), false);
});

test("a second broker cannot replace the running socket and can close its own database", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-memory-duplicate-"));
  const owner = new MemoryIntegration({ dataDir });
  await owner.ready;
  const duplicate = new MemoryIntegration({ dataDir });
  t.after(async () => {
    await owner.close();
    duplicate.memory.close();
    fs.rmSync(path.dirname(owner.broker.socketPath), { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await assert.rejects(duplicate.ready, /already running/);
  await duplicate.close();
  assert.equal(duplicate.memory.closed, true);
  assert.equal(owner.broker.server.listening, true);
  assert.equal(fs.existsSync(owner.broker.socketPath), true);
});

test("broker replaces its stale socket after an abrupt server exit", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-memory-stale-"));
  const module = new URL(
    "../../server/features/memory/memory-integration.js",
    import.meta.url,
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { MemoryIntegration } from ${JSON.stringify(module)};
    const integration = new MemoryIntegration({dataDir:process.argv[1]});
    await integration.ready;
    process.send(integration.broker.socketPath);
  `,
      dataDir,
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: process.env.PATH } },
  );
  let replacement, socketPath;
  t.after(async () => {
    child.kill("SIGKILL");
    await replacement?.close();
    if (socketPath) fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  [socketPath] = await once(child, "message", { signal: AbortSignal.timeout(5000) });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal(fs.existsSync(socketPath), true);
  replacement = new MemoryIntegration({ dataDir });
  await replacement.ready;
  assert.equal(replacement.broker.socketPath, socketPath);
  assert.equal(replacement.broker.server.listening, true);
});
