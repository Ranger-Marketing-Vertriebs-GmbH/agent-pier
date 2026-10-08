import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAdapter } from "../../server/features/adapter-runtime/adapter-supervisor.js";
import { createAdapterListener } from "../../server/features/adapter-runtime/adapter-listener.js";
import { scriptedUpstream, sse } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { KEY, validAdapterConfig, authorized } from "../helpers/adapter-fixture.js";
import {
  alive,
  bindError,
  childPids,
  closed,
  rawSocket,
  until,
  writeStub,
} from "../helpers/adapter-process.js";

const readRecord = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

test("a crashed adapter is restarted on the same port with the same token", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const adapter = await startAdapter(
    validAdapterConfig({
      upstream: { baseUrl: `${up.base}/v1`, authHeader: null, apiKey: KEY },
    }),
    { restart: { delayMs: 1000 } },
  );
  t.after(() => adapter.stop());
  const { url } = adapter;
  const first = adapter.child.pid;
  process.kill(first, "SIGKILL");
  await until(() => !alive(first));
  // Restart window: the port stays bound by the supervisor, nobody else can take it …
  assert.equal(adapter.restarts(), 0, "still inside the restart delay");
  assert.equal(await bindError(adapter.port), "EADDRINUSE");
  // … and a request sent now waits for the restarted adapter instead of failing.
  const res = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(loadFixture("clients/claude-code/text.json").body),
  });
  assert.match(await res.text(), /message_stop/);
  assert.equal(adapter.restarts(), 1);
  assert.notEqual(adapter.child.pid, first);
  assert.equal(adapter.url, url);
});

test("the restart budget is bounded; give-up keeps the port and the last counters", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const diagnosticsPath = path.join(dir, "s.adapter.json");
  const adapter = await startAdapter(validAdapterConfig({ diagnosticsPath }), {
    restart: { max: 3, windowMs: 60_000, delayMs: 50 },
  });
  t.after(() => adapter.stop());
  // One counted request so the first adapter writes a snapshot.
  assert.equal(
    (await fetch(`${adapter.url}/v1/messages`, { method: "POST" })).status,
    401,
  );
  await until(() => readRecord(diagnosticsPath)?.unauthorized === 1);
  for (let restart = 1; restart <= 3; restart += 1) {
    const pid = adapter.child.pid;
    process.kill(pid, "SIGKILL");
    await until(() => adapter.restarts() === restart && adapter.child.pid !== pid, 5000);
  }
  // 4th crash: budget spent → no new child, the give-up is recorded.
  const pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  await until(() => readRecord(diagnosticsPath)?.supervisor?.gaveUpAt, 5000);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(adapter.child.pid, pid, "no further restart");
  assert.equal(adapter.restarts(), 3);
  const record = readRecord(diagnosticsPath);
  assert.equal(record.supervisor.restarts, 3);
  assert.equal(record.supervisor.lastReason, "exited");
  assert.equal(record.unauthorized, 1, "restarts that served nothing keep the counters");
  assert.equal(fs.statSync(diagnosticsPath).mode & 0o777, 0o600);
  // The port stays reserved, and the CLI gets an immediate 503 in its own error format.
  assert.equal(await bindError(adapter.port), "EADDRINUSE");
  const started = Date.now();
  const res = await fetch(`${adapter.url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: "{}",
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.type, "error");
  assert.match(body.error.message, /repeated crashes/);
  assert.ok(Date.now() - started < 2000);
  await adapter.stop();
  assert.equal(await bindError(adapter.port), null, "stop releases the port");
});

test("a failed restart attempt consumes the budget", async (t) => {
  // Stub: the 2nd process exits 71 without a message (start failure); the others are ready.
  const stub = writeStub(t, "");
  const counter = path.join(stub.dir, "count");
  const diagnosticsPath = path.join(stub.dir, "s.adapter.json");
  fs.writeFileSync(
    stub.file,
    `import fs from "node:fs";
let n = 1;
try { n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) + 1; } catch {}
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
process.on("disconnect", () => process.exit(0));
process.once("message", (m) => {
  if (n === 2) process.exit(71);
  process.send({ type: "ready", port: m.port });
});
setInterval(() => {}, 1000);\n`,
  );
  const adapter = await startAdapter(validAdapterConfig({ diagnosticsPath }), {
    entry: stub.file,
    restart: { max: 2, delayMs: 20 },
  });
  t.after(() => adapter.stop());
  let pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  await until(() => adapter.restarts() === 2 && adapter.child.pid !== pid);
  pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  await until(() => readRecord(diagnosticsPath)?.supervisor?.gaveUpAt);
  assert.equal(readRecord(diagnosticsPath).supervisor.restarts, 2);
  assert.equal(fs.readFileSync(counter, "utf8"), "3");
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
  const stub = writeStub(t, "");
  const marker = path.join(stub.dir, "started");
  fs.writeFileSync(
    stub.file,
    `import fs from "node:fs";
const first = !fs.existsSync(${JSON.stringify(marker)});
fs.writeFileSync(${JSON.stringify(marker)}, "");
process.on("message", (m) => { if (first) process.send({ type: "ready", port: m.port }); });
setInterval(() => {}, 1000);\n`,
  );
  const adapter = await startAdapter(validAdapterConfig(), {
    entry: stub.file,
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

test("stop during a restart closes queued connections and releases the port", async (t) => {
  const adapter = await startAdapter(validAdapterConfig(), {
    restart: { delayMs: 2000 },
  });
  const pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  await until(() => !alive(pid));
  const socket = await rawSocket(t, adapter.port); // waits in the restart queue
  const ended = closed(socket);
  const started = Date.now();
  await adapter.stop();
  await ended;
  assert.ok(Date.now() - started < 1000, "queued connection closed by stop()");
  assert.equal(await bindError(adapter.port), null);
  assert.equal(adapter.restarts(), 0);
});

test("the restart queue is bounded in size and age", async (t) => {
  const listener = await createAdapterListener({ maxQueued: 2, maxAgeMs: 300 });
  t.after(() => listener.close());
  const first = await rawSocket(t, listener.port);
  const firstClosed = closed(first);
  await until(() => listener.queued() === 1);
  await rawSocket(t, listener.port);
  await until(() => listener.queued() === 2);
  const overflow = await rawSocket(t, listener.port);
  await closed(overflow); // the third connection is closed at once
  assert.equal(listener.queued(), 2);
  await firstClosed; // aged out after maxAgeMs
  await until(() => listener.queued() === 0);
});

test("no adapter child outlives the tests", async () => {
  await until(() => childPids().length === 0, 3000);
});
