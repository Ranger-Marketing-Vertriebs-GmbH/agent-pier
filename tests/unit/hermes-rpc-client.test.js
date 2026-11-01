import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import {
  HermesRpcClient,
  methodNotFound,
} from "../../server/features/assistants/runtimes/hermes/hermes-rpc-client.js";
import {
  rpcTransport,
  stdioTransport,
} from "../../server/features/assistants/runtimes/hermes/hermes-transport.js";
import { memoryTransport } from "../helpers/hermes-fake-gateway.js";

const ready = {
  jsonrpc: "2.0",
  method: "event",
  params: { type: "gateway.ready", payload: {} },
};
const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await tick();
};

// A client over a memory transport whose peer answers client.capabilities.
async function connected(options) {
  const { transport, peer } = memoryTransport();
  const client = new HermesRpcClient(transport, options);
  peer.on("frame", (frame) => {
    if (frame.method === "client.capabilities")
      peer.send({
        jsonrpc: "2.0",
        id: frame.id,
        result: { server_requests: ["approval"] },
      });
  });
  peer.send(ready);
  await client.connect({ timeoutMs: 1000 });
  return { client, peer };
}

test("connect waits for gateway.ready and declares server requests", async () => {
  const { transport, peer } = memoryTransport();
  const client = new HermesRpcClient(transport);
  // Before the gateway is ready no call goes out.
  await assert.rejects(
    client.call("ping"),
    (e) => e.code === "UNAVAILABLE" && e.status === 503,
  );
  const connecting = client.connect({ timeoutMs: 1000 });
  await settle();
  assert.deepEqual(peer.frames, []);
  peer.on("frame", (frame) =>
    peer.send({
      jsonrpc: "2.0",
      id: frame.id,
      result: { server_requests: ["approval"] },
    }),
  );
  peer.send(ready);
  await connecting;
  assert.equal(client.ready, true);
  assert.deepEqual(peer.frames, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "client.capabilities",
      params: { server_requests: true },
    },
  ]);
  assert.deepEqual(client.capabilities, { server_requests: ["approval"] });
});

test("connect fails on a timeout or a transport that closes first", async () => {
  const quiet = new HermesRpcClient(memoryTransport().transport);
  await assert.rejects(quiet.connect({ timeoutMs: 5 }), (e) => e.code === "TIMEOUT");
  const { transport, peer } = memoryTransport();
  const dropped = new HermesRpcClient(transport);
  const connecting = dropped.connect({ timeoutMs: 1000 });
  peer.close();
  await assert.rejects(connecting, (e) => e.code === "UNAVAILABLE" && e.status === 503);
  await assert.rejects(dropped.connect(), (e) => e.code === "UNAVAILABLE");
});

test("calls resolve with Hermes's result and reject answered errors with its code", async () => {
  const { client, peer } = await connected();
  peer.on("frame", (frame) => {
    if (frame.method === "session.history")
      peer.send({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: 4001, message: "not_found", data: { reason: "not_found" } },
      });
    if (frame.method === "session.mutate")
      peer.send({
        jsonrpc: "2.0",
        id: frame.id,
        error: {
          code: 4001,
          message: "revision_conflict",
          data: { reason: "revision_conflict", revision: 4, execution_generation: 2 },
        },
      });
    if (frame.method === "session.title")
      peer.send({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: -32601, message: "unknown method: session.title" },
      });
    if (frame.method === "ping")
      peer.send({ jsonrpc: "2.0", id: frame.id, result: { pong: true } });
    if (frame.method === "odd")
      peer.send({ jsonrpc: "2.0", id: frame.id, error: { code: 5999 } });
  });
  assert.deepEqual(await client.call("ping", {}), { pong: true });
  await assert.rejects(client.call("session.history", { session_id: "x" }), (error) => {
    assert.equal(error.answered, true);
    assert.equal(error.code, "NOT_FOUND");
    assert.equal(error.hermesCode, 4001);
    assert.equal(error.status, 503);
    assert.equal(error.reason, "not_found");
    assert.equal(error.remoteMessage, "not_found");
    return true;
  });
  // A fenced refusal names the session's current fences.
  await assert.rejects(client.call("session.mutate", {}), (error) => {
    assert.equal(error.code, "CONFLICT");
    assert.deepEqual(error.fences, { revision: 4, execution_generation: 2 });
    return true;
  });
  await assert.rejects(
    client.call("session.title", {}),
    (e) => e.code === "UNKNOWN_METHOD" && e.reason === null,
  );
  await assert.rejects(client.call("odd"), (e) => e.code === "RPC_FAILED" && e.answered);
  // Ids are integers that never repeat on a connection.
  const ids = peer.frames.map((frame) => frame.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(Number.isSafeInteger));
});

test("a timed-out call rejects TIMEOUT and hears a late answer once", async () => {
  const { client, peer } = await connected({ timeoutMs: 5 });
  const late = [];
  await assert.rejects(
    client.call("prompt.submit", {}, { onLate: (ok, result) => late.push([ok, result]) }),
    (e) => e.code === "TIMEOUT" && e.status === 503 && !e.answered,
  );
  const { id } = peer.frames.at(-1);
  peer.send({ jsonrpc: "2.0", id, result: { status: "streaming" } });
  peer.send({ jsonrpc: "2.0", id, result: { status: "again" } });
  await settle();
  assert.deepEqual(late, [[true, { status: "streaming" }]]);
});

test("a closed transport rejects pending calls as OpenClaw's closed client does", async () => {
  const { client, peer } = await connected({ timeoutMs: 1000 });
  let drops = 0;
  client.on("disconnected", () => drops++);
  const late = [];
  const pending = client.call("prompt.submit", {}, { onLate: () => late.push(1) });
  await settle();
  peer.close();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "CLOSED");
    assert.equal(error.status, 503);
    assert.equal(error.message, "Assistant Gateway closed.");
    return true;
  });
  assert.equal(client.ready, false);
  await assert.rejects(
    client.call("ping"),
    (e) => e.code === "UNAVAILABLE" && e.status === 503,
  );
  client.close();
  assert.equal(drops, 1);
  assert.deepEqual(late, []);
});

test("close() ends the connection and the transport", async () => {
  const { client, peer } = await connected();
  const pending = client.call("ping");
  await settle();
  client.close();
  await assert.rejects(pending, (e) => e.code === "CLOSED");
  assert.equal(peer.closed(), true);
});

test("server requests are answered by their handler or with -32601", async () => {
  const { client, peer } = await connected();
  const answers = [];
  peer.on("frame", (frame) => frame.method === undefined && answers.push(frame));
  let later;
  client.handle("approval", (params, { id }) => {
    later = () => client.respond(id, { result: { choice: params.answer } });
    return undefined;
  });
  client.handle("sudo", () => ({ value: "no" }));
  client.handle("secret", () => {
    throw new Error("refused");
  });
  peer.send({ jsonrpc: "2.0", id: "srq-1", method: "clarify", params: {} });
  peer.send({ jsonrpc: "2.0", id: "srq-2", method: "sudo", params: {} });
  peer.send({
    jsonrpc: "2.0",
    id: "srq-3",
    method: "approval",
    params: { answer: "deny" },
  });
  peer.send({ jsonrpc: "2.0", id: "srq-4", method: "secret", params: {} });
  await settle();
  later();
  await settle();
  const byId = Object.fromEntries(answers.map((a) => [a.id, a]));
  assert.equal(byId["srq-1"].error.code, methodNotFound);
  assert.deepEqual(byId["srq-2"].result, { value: "no" });
  assert.deepEqual(byId["srq-3"].result, { choice: "deny" });
  assert.equal(byId["srq-4"].error.code, methodNotFound);
});

test("events reach subscribers; lines that are no frames are ignored", async () => {
  const { client, peer } = await connected();
  const seen = [];
  const unsubscribe = client.subscribe((params) => seen.push(params.type));
  peer.sendLine("Hermes says hello");
  peer.sendLine("[1, 2]");
  peer.send({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "message.delta", payload: {} },
  });
  await settle();
  unsubscribe();
  peer.send({ jsonrpc: "2.0", method: "event", params: { type: "message.complete" } });
  await settle();
  assert.deepEqual(seen, ["message.delta"]);
});

// A child process with piped stdio, as the supervisor spawns the RPC bridge.
function fakeBridge() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.written = [];
  child.stdin.on("data", (chunk) => child.written.push(String(chunk)));
  return child;
}

test("the bridge channel frames its stdio and hands the client gateway.ready once", async () => {
  const child = fakeBridge();
  const channel = stdioTransport(child);
  child.stdout.write(
    '{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready"}}\n',
  );
  child.stdout.write("not a frame\n");
  assert.equal((await channel.ready).params.type, "gateway.ready");
  // The supervisor connects a client only once the channel is ready.
  const transport = rpcTransport(channel);
  const client = new HermesRpcClient(transport, { timeoutMs: 1000 });
  const connecting = client.connect({ timeoutMs: 1000 });
  await settle();
  const capabilities = JSON.parse(child.written.at(-1));
  assert.equal(capabilities.method, "client.capabilities");
  child.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: capabilities.id, result: {} })}\n`,
  );
  await connecting;
  const seen = [];
  client.subscribe((params) => seen.push(params.type));
  child.stdout.write(
    '{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready"}}\n',
  );
  child.stdout.write(
    '{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta"}}\n',
  );
  await settle();
  assert.deepEqual(seen, ["message.delta"]);
  // The bridge's exit closes the client: pending calls reject, later ones are refused.
  const pending = client.call("session.list", {});
  child.emit("exit", 0);
  await assert.rejects(pending, (e) => e.code === "CLOSED" && e.status === 503);
  assert.equal(client.closed, true);
  assert.equal(transport.write("{}"), false);
});

test("closing the client ends the bridge's stdin once", async () => {
  const child = fakeBridge();
  const channel = stdioTransport(child);
  const transport = rpcTransport(channel);
  let closes = 0;
  transport.on("close", () => closes++);
  let ended = false;
  child.stdin.on("finish", () => (ended = true));
  transport.close();
  transport.close();
  child.emit("exit", 0);
  await settle();
  assert.equal(ended, true);
  assert.equal(closes, 1);
});
