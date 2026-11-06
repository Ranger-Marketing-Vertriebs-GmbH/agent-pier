import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import WebSocket from "ws";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";
import { nativePushValue } from "../../server/features/requests/native-push.js";
import { createCodexProxy } from "../../server/features/requests/codex-proxy.js";
import { DeliveryAcceptance } from "../../server/features/chat/delivery-acceptance.js";
import { codexProxyAcceptance } from "../../server/application/chat-delivery-wiring.js";
import { until } from "../helpers/adapter-process.js";

/** A broker wired like services.js: prompt pushes reach a real acceptance matcher. */
async function fixture(t) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "codex-prompt-")),
  );
  const tools = { s1: "codex" };
  const session = (id) => ({
    id,
    accountId: `account-${id}`,
    tool: tools[id],
    status: "running",
    nativeRequests: { enabled: true },
  });
  const matches = [];
  const acceptance = new DeliveryAcceptance({
    onMatch: (...match) => matches.push(match),
  });
  const pushes = [];
  const broker = new RequestBroker({
    dataDir,
    sessions: { get: async (id) => session(id) },
    onNative: (sessionId, push) => {
      pushes.push({ sessionId, ...push });
      codexProxyAcceptance(sessionId, push, () => ({ acceptance }));
    },
  });
  await broker.ready;
  const launches = {};
  for (const id of Object.keys(tools))
    launches[id] = await broker.prepare({
      id,
      account: { id: `account-${id}`, tool: tools[id] },
      cwd: dataDir,
      launch: { command: "/fixture/cli", args: [], env: {} },
    });
  t.after(async () => {
    await broker.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { acceptance, matches, pushes, launches };
}

test("Codex prompt pushes confirm a delivery at the server's receive time", async (t) => {
  const f = await fixture(t);
  const channel = new NativeRequestChannel({ env: f.launches.s1.env });
  t.after(() => channel.close());
  await channel.ready;
  channel.prompt({ type: "prompt-ready" });
  await until(() => f.acceptance.supports("s1"));
  f.acceptance.expect("s1", {
    deliveryId: "d1",
    since: Date.now() - 1,
    imageNames: ["red.png"],
  });
  // The proxy's own clock is not used: a stale `at` still matches.
  channel.prompt({
    type: "prompt",
    kind: "accepted",
    at: 0,
    imageNames: null,
    imageCount: 1,
  });
  await until(() => f.matches.length === 1);
  assert.deepEqual(f.matches, [["s1", "d1", { kind: "accepted" }]]);
  f.acceptance.expect("s1", { deliveryId: "d2", since: Date.now() - 1, imageNames: [] });
  channel.prompt({ type: "prompt", kind: "dropped", imageCount: 0, reason: "blocked" });
  await until(() => f.matches.length === 2);
  assert.deepEqual(f.matches[1], ["s1", "d2", { kind: "dropped", reason: "blocked" }]);
});

test("the channel repeats prompt-ready after a reconnect", async (t) => {
  const f = await fixture(t);
  const channel = new NativeRequestChannel({ env: f.launches.s1.env });
  t.after(() => channel.close());
  await channel.ready;
  channel.prompt({ type: "prompt-ready" });
  await until(() => f.acceptance.supports("s1"));
  // A new launch forgets every source; the server sees the proxy again on reconnect.
  f.acceptance.forget("s1");
  channel.socket.destroy();
  await until(() => f.acceptance.supports("s1"), 5000);
});

test("a Codex prompt push never throws into the rest of the push handling", () => {
  // Before the chat delivery exists its binding is still in its temporal dead zone.
  const early = () => {
    throw new ReferenceError("Cannot access 'chatDelivery' before initialization");
  };
  for (const push of [{ type: "prompt-ready" }, { type: "prompt", kind: "accepted" }])
    assert.doesNotThrow(() => codexProxyAcceptance("s1", push, early));
  const failing = {
    acceptance: {
      ready() {},
      report() {
        throw Error("matcher down");
      },
    },
  };
  assert.doesNotThrow(() =>
    codexProxyAcceptance("s1", { type: "prompt", kind: "accepted" }, () => failing),
  );
});

test("prompt pushes are validated", () => {
  assert.deepEqual(nativePushValue({ type: "prompt-ready", extra: 1 }), {
    type: "prompt-ready",
  });
  assert.deepEqual(
    nativePushValue({ type: "prompt", kind: "accepted", imageCount: 2, reason: "x" }),
    { type: "prompt", kind: "accepted", imageCount: 2 },
  );
  assert.deepEqual(
    nativePushValue({ type: "prompt", kind: "dropped", imageCount: 0, reason: "no" }),
    { type: "prompt", kind: "dropped", imageCount: 0, reason: "no" },
  );
  assert.deepEqual(
    nativePushValue({
      type: "prompt",
      kind: "dropped",
      imageCount: 0,
      reason: "x".repeat(501),
    }),
    { type: "prompt", kind: "dropped", imageCount: 0 },
  );
  for (const bad of [
    { type: "prompt" },
    { type: "prompt", kind: "queued", imageCount: 0 },
    { type: "prompt", kind: "accepted", imageCount: -1 },
    { type: "prompt", kind: "accepted", imageCount: 1.5 },
    { type: "prompt", kind: "accepted", imageCount: "1" },
  ])
    assert.throws(() => nativePushValue(bad), /Invalid native push/);
});

test("the Codex proxy reports prompt-ready and the prompts Codex took", async (t) => {
  const incoming = new PassThrough(),
    outgoing = new PassThrough();
  const written = [];
  outgoing.on("data", (chunk) =>
    written.push(...String(chunk).trim().split("\n").map(JSON.parse)),
  );
  const prompts = [];
  const channel = {
    publish() {},
    resolve() {},
    prompt: (event) => prompts.push(event),
    close() {},
  };
  const proxy = await createCodexProxy({ input: incoming, output: outgoing, channel });
  t.after(async () => {
    await proxy.close();
    incoming.destroy();
    outgoing.destroy();
  });
  const tui = new WebSocket(proxy.url, {
    headers: { Authorization: `Bearer ${proxy.authToken}` },
  });
  t.after(() => tui.terminate());
  await once(tui, "open");
  await until(() => prompts.length === 1);
  assert.deepEqual(prompts, [{ type: "prompt-ready" }]);
  const start = {
    id: 6,
    method: "turn/start",
    params: { threadId: "t", clientUserMessageId: "c1", input: [{ type: "text" }] },
  };
  tui.send(JSON.stringify(start));
  await until(() => written.length === 1);
  assert.deepEqual(written, [start], "the request reaches Codex unchanged");
  const item = {
    method: "item/started",
    params: { threadId: "t", turnId: "u", item: { type: "userMessage", clientId: "c1" } },
  };
  const frame = once(tui, "message");
  incoming.write(JSON.stringify(item) + "\n");
  assert.deepEqual(JSON.parse(String((await frame)[0])), item);
  assert.equal(prompts.length, 2);
  assert.deepEqual(
    { ...prompts[1], at: typeof prompts[1].at },
    { type: "prompt", kind: "accepted", at: "number", imageNames: null, imageCount: 0 },
  );
});
