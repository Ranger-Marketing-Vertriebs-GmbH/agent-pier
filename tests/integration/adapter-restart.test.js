import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { startAdapter } from "../../server/features/adapter-runtime/adapter-supervisor.js";
import { scriptedUpstream, sse } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { KEY, validAdapterConfig, authorized } from "../helpers/adapter-fixture.js";
import { alive, childPids, until } from "../helpers/adapter-process.js";

test("a crashed adapter is restarted on the same port with the same token", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const adapter = await startAdapter(
    validAdapterConfig({
      upstream: { baseUrl: `${up.base}/v1`, authHeader: null, apiKey: KEY },
    }),
    { restart: { delayMs: 50 } },
  );
  t.after(() => adapter.stop());
  const { url } = adapter;
  const first = adapter.child.pid;
  process.kill(first, "SIGKILL");
  await until(() => adapter.child.pid !== first && adapter.restarts() === 1);
  assert.equal(adapter.url, url);
  const res = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(loadFixture("clients/claude-code/text.json").body),
  });
  assert.match(await res.text(), /message_stop/);
});

test("the restart budget is bounded and a taken port counts as a failed restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const diagnosticsPath = path.join(dir, "s.adapter.json");
  const adapter = await startAdapter(validAdapterConfig({ diagnosticsPath }), {
    restart: { max: 3, windowMs: 60_000, delayMs: 300 },
  });
  t.after(() => adapter.stop());
  // 1st crash: occupy the port during the restart delay → bind failure consumes one attempt; release it → next attempt succeeds
  let pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  await until(() => !alive(pid)); // the port is free only once the process is gone
  const blocker = net.createServer().listen(adapter.port, "127.0.0.1");
  await once(blocker, "listening");
  await new Promise((r) => setTimeout(r, 400));
  blocker.close();
  await until(() => adapter.child.pid !== pid && alive(adapter.child.pid), 3000);
  // 2nd crash consumes the 3rd attempt
  pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  await until(() => adapter.child.pid !== pid);
  // 3rd crash: budget spent → no new child, diagnostics record the give-up
  pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  // Nothing was requested, so the file appears only with the give-up record.
  await until(() => {
    try {
      return JSON.parse(fs.readFileSync(diagnosticsPath, "utf8")).supervisor?.gaveUpAt;
    } catch {
      return false;
    }
  }, 3000);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(adapter.child.pid, pid, "no further restart");
  const record = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8")).supervisor;
  assert.equal(record.restarts, 3);
  assert.equal(fs.statSync(diagnosticsPath).mode & 0o777, 0o600);
});

test("stop during a pending restart leaves no adapter behind", async () => {
  const adapter = await startAdapter(validAdapterConfig(), { restart: { delayMs: 300 } });
  const pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  await until(() => !alive(pid));
  await adapter.stop(); // inside the restart delay
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(adapter.child.pid, pid, "no restart after stop");
  assert.equal(
    await fetch(`${adapter.url}/api/hello`, { method: "HEAD" }).catch(() => null),
    null,
  );
});

test("stop waits for an adapter that is still starting", async (t) => {
  // Stub entry: the first process reports ready; every later one stays silent (marker file),
  // so the restart attempt is still "starting" when stop() runs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-slow-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "started");
  const stub = path.join(dir, "stub.mjs");
  fs.writeFileSync(
    stub,
    `import fs from "node:fs";
const first = !fs.existsSync(${JSON.stringify(marker)});
fs.writeFileSync(${JSON.stringify(marker)}, "");
process.on("message", () => { if (first) process.send({ type: "ready", port: 47999 }); });
setInterval(() => {}, 1000);\n`,
  );
  const adapter = await startAdapter(validAdapterConfig(), {
    entry: stub,
    timeoutMs: 5000,
    restart: { delayMs: 20 },
  });
  process.kill(adapter.child.pid, "SIGKILL");
  let startingPid = null;
  await until(() => (startingPid = adapter.startingPid()) !== null);
  await adapter.stop();
  assert.equal(
    alive(startingPid),
    false,
    "the starting child is gone when stop() resolves",
  );
  assert.equal(adapter.restarts(), 1);
});

test("no adapter child outlives the tests", async () => {
  await until(() => childPids().length === 0, 3000);
});
