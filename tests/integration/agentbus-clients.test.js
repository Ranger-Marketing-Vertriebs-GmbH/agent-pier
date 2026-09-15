import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const feature = new URL("../../server/features/agentbus/", import.meta.url);
async function fixture(t, handle = () => ({})) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-client-"));
  const socket = path.join(dir, "broker.sock");
  const credential = path.join(dir, "cap.json");
  fs.writeFileSync(
    credential,
    JSON.stringify({ version: 1, sessionId: "launch", token: "a".repeat(64) }),
    { mode: 0o600 },
  );
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const message = JSON.parse(body);
    calls.push(message);
    assert.equal(req.headers.authorization, `Bearer launch.${"a".repeat(64)}`);
    assert.equal(req.url, "/mcp");
    const result = await handle(message, res);
    if (result === undefined) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(socket);
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    calls,
    credential,
    env: {
      AGENTPIER_AGENTBUS_SOCKET: socket,
      AGENTPIER_AGENTBUS_CAPABILITY_FILE: credential,
    },
  };
}
async function run(script, env, input, args = []) {
  const child = spawn(process.execPath, [new URL(script, feature).pathname, ...args], {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (part) => (stdout += part));
  child.stderr.on("data", (part) => (stderr += part));
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Condition not reached");
}

test("client authenticates and rejects unsafe credentials and oversized requests", async (t) => {
  const f = await fixture(t, () => ({ ok: true }));
  const { agentbusClient } = await import(new URL("agentbus-client.js", feature));
  const relay = agentbusClient(f.env);
  assert.deepEqual(
    (await relay({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result,
    { ok: true },
  );
  await assert.rejects(relay({ body: "x".repeat(65537) }));
  fs.chmodSync(f.credential, 0o644);
  assert.throws(() => agentbusClient(f.env));
});

test("hook emits native context and stays nonfatal on invalid or oversized input", async (t) => {
  const f = await fixture(t, () => ({ context: "pending hint" }));
  const result = await run("agentbus-hook.js", f.env, '{"session_id":"native"}', [
    "SessionStart",
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "pending hint",
    },
  });
  assert.equal(f.calls[0].method, "agentbus/hook");
  assert.equal(f.calls[0].params.nativeSessionId, "native");
  assert.ok(f.calls[0].params.pid > 0);
  const invalid = await run("agentbus-hook.js", f.env, "x".repeat(65537), [
    "SessionStart",
  ]);
  assert.equal(invalid.code, 0);
  assert.equal(invalid.stdout, "");
  assert.equal(f.calls.length, 1);
});

test("MCP relays calls once after initialize and handles large inbox responses", async (t) => {
  const f = await fixture(t, (message) =>
    message.method === "initialize"
      ? { serverInfo: { name: "agentpier_agentbus" } }
      : { content: [{ type: "text", text: "x".repeat(300000) }] },
  );
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "inbox_read", arguments: {} },
    },
  ];
  const result = await run(
    "agentbus-mcp.js",
    f.env,
    messages.map(JSON.stringify).join("\n") + "\n",
  );
  assert.equal(result.code, 0);
  const replies = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies[1].result.content[0].text.length, 300000);
  assert.equal(f.calls.length, 2);
});

test("OpenCode routes notices only to active root sessions and disposes polling", async (t) => {
  let waiting;
  const f = await fixture(t, (message, res) => {
    if (message.method === "agentbus/wait") {
      waiting = res;
      return undefined;
    }
    if (message.method === "agentbus/summary") return { context: "pending hint" };
    return {};
  });
  const { default: plugin } = await import(new URL("agentbus-opencode.js", feature));
  const prompts = [];
  const hooks = await plugin(
    {
      client: {
        session: {
          get: async ({ path: p }) => ({
            data: { id: p.id, parentID: p.id === "child" ? "root" : undefined },
          }),
          promptAsync: async (value) => prompts.push(value),
        },
      },
    },
    { ...f.env, AGENTPIER_AGENTBUS_NODE: process.execPath },
  );
  t.after(() => hooks.dispose());
  const config = {};
  await hooks.config(config);
  assert.deepEqual(config.mcp.agentpier_agentbus.environment, f.env);
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "root" } } },
  });
  await until(() => waiting);
  const output = { args: {} };
  await hooks["tool.execute.before"](
    { tool: "agentpier_agentbus_peer_send", sessionID: "root" },
    output,
  );
  assert.equal(output.args.__agentpierSession, "root");
  await hooks.event({
    event: { type: "session.deleted", properties: { sessionID: "root" } },
  });
  waiting.end(
    JSON.stringify({
      jsonrpc: "2.0",
      result: {
        notifications: [
          { nativeSessionId: "root", text: "hint" },
          { nativeSessionId: "unknown", text: "hint" },
        ],
      },
    }),
  );
  await delay(30);
  assert.equal(prompts.length, 0);
  const child = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "child" }, child);
  assert.deepEqual(child.system, []);
  const root = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "new-root" }, root);
  assert.ok(root.system.some((text) => text.includes("pending hint")));
  await until(() => f.calls.filter((m) => m.method === "agentbus/wait").length === 2);
  waiting.end(
    JSON.stringify({
      jsonrpc: "2.0",
      result: { notifications: [{ nativeSessionId: "new-root", text: "new hint" }] },
    }),
  );
  await until(() => prompts.length === 1);
  assert.equal(prompts[0].path.id, "new-root");
  await hooks.dispose();
  const count = f.calls.length;
  await delay(50);
  assert.equal(f.calls.length, count);
  assert.ok(f.calls.every((m) => m.method !== "tools/call"));
});

test("MCP refuses calls before initialization and never replays failed inbox reads", async (t) => {
  const f = await fixture(t, (message, res) => {
    if (message.method === "initialize") return {};
    res.destroy();
    return undefined;
  });
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox_read" } },
    { jsonrpc: "2.0", id: 2, method: "initialize" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "inbox_read" } },
  ];
  const result = await run(
    "agentbus-mcp.js",
    f.env,
    messages.map(JSON.stringify).join("\n") + "\n",
  );
  const replies = result.stdout.trim().split("\n").map(JSON.parse);
  assert.ok(replies[0].error);
  assert.ok(replies[2].error);
  assert.deepEqual(
    f.calls.map((m) => m.method),
    ["initialize", "tools/call"],
  );
});

test("OpenCode reconnects notices after transport failure and unregisters on disposal", async (t) => {
  let waits = 0;
  const f = await fixture(t, (message, res) => {
    if (message.method !== "agentbus/wait") return {};
    if (++waits === 1) {
      res.destroy();
      return undefined;
    }
    return waits === 2
      ? { notifications: [{ nativeSessionId: "root", text: "pending" }] }
      : undefined;
  });
  const { default: plugin } = await import(new URL("agentbus-opencode.js", feature));
  const prompts = [];
  const hooks = await plugin(
    { client: { session: { promptAsync: async (value) => prompts.push(value) } } },
    f.env,
  );
  t.after(() => hooks.dispose());
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "root" } } },
  });
  await until(() => prompts.length === 1);
  await hooks.dispose();
  assert.ok(
    f.calls.some(
      (m) => m.method === "agentbus/unregister" && m.params.nativeSessionId === "root",
    ),
  );
});

test("client bounds responses and supports cancellation", async (t) => {
  const f = await fixture(t, (message, res) => {
    if (message.method === "large") return { text: "x".repeat(1048576) };
    res.writeHead(200);
    res.write("{");
    return undefined;
  });
  const { agentbusClient } = await import(new URL("agentbus-client.js", feature));
  const relay = agentbusClient(f.env);
  await assert.rejects(relay({ method: "large" }));
  const controller = new AbortController();
  const pending = relay({ method: "agentbus/wait" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
});

test("client rejects a missing launch identity before contacting the broker", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.credential, JSON.stringify({ version: 1, token: "a".repeat(64) }));
  const { agentbusClient } = await import(new URL("agentbus-client.js", feature));
  assert.throws(() => agentbusClient(f.env));
  assert.equal(f.calls.length, 0);
});

test("OpenCode MCP uses the supplied host Node even inside another runtime", async (t) => {
  const f = await fixture(t);
  const { default: plugin } = await import(new URL("agentbus-opencode.js", feature));
  const hostNode = process.execPath;
  const hooks = await plugin({}, { ...f.env, AGENTPIER_AGENTBUS_NODE: hostNode });
  t.after(() => hooks.dispose());
  const original = Object.getOwnPropertyDescriptor(process, "execPath");
  Object.defineProperty(process, "execPath", { ...original, value: "/fake/opencode" });
  try {
    const config = {};
    await hooks.config(config);
    assert.equal(config.mcp.agentpier_agentbus.command[0], hostNode);
  } finally {
    Object.defineProperty(process, "execPath", original);
  }
});

test("OpenCode refuses absent, relative, missing and nonexecutable host runtimes", async (t) => {
  const f = await fixture(t);
  const { default: plugin } = await import(new URL("agentbus-opencode.js", feature));
  for (const runtime of [
    undefined,
    "node",
    "/missing/agentbus-node",
    f.credential,
    path.dirname(f.credential),
  ]) {
    const hooks = await plugin({}, { ...f.env, AGENTPIER_AGENTBUS_NODE: runtime });
    t.after(() => hooks.dispose());
    await assert.rejects(hooks.config({}), /runtime/i);
  }
});

test("OpenCode reads summaries without registering again on each model request", async (t) => {
  const f = await fixture(t, (message) => {
    if (message.method === "agentbus/wait") return undefined;
    return { context: "pending summary" };
  });
  const { default: plugin } = await import(new URL("agentbus-opencode.js", feature));
  const hooks = await plugin(
    { client: { session: { get: async () => ({ data: { id: "root" } }) } } },
    f.env,
  );
  t.after(() => hooks.dispose());
  for (let i = 0; i < 3; i++) {
    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "root" }, output);
    assert.ok(output.system.includes("pending summary"));
  }
  assert.equal(f.calls.filter((m) => m.method === "agentbus/register").length, 1);
  assert.equal(f.calls.filter((m) => m.method === "agentbus/summary").length, 3);
  assert.equal(f.calls.filter((m) => m.method === "agentbus/hook").length, 0);
  assert.equal(
    f.calls.find((m) => m.method === "agentbus/register").params.pid,
    process.pid,
  );
});

test("OpenCode registers again only when summary reports a missing native peer", async (t) => {
  let summaries = 0;
  const f = await fixture(t, (message, res) => {
    if (message.method === "agentbus/wait") return undefined;
    if (message.method === "agentbus/summary" && ++summaries === 1) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32004, message: "Session not registered" },
        }),
      );
      return undefined;
    }
    return { context: "restored summary" };
  });
  const { default: plugin } = await import(new URL("agentbus-opencode.js", feature));
  const hooks = await plugin(
    { client: { session: { get: async () => ({ data: { id: "root" } }) } } },
    f.env,
  );
  t.after(() => hooks.dispose());
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "root" }, output);
  assert.ok(output.system.includes("restored summary"));
  assert.equal(f.calls.filter((m) => m.method === "agentbus/register").length, 2);
  assert.equal(summaries, 2);
});

test("OpenCode cancels the pending wait when its last session is deleted", async (t) => {
  let waiting;
  let closed = false;
  const f = await fixture(t, (message, res) => {
    if (message.method !== "agentbus/wait") return {};
    waiting = res;
    res.on("close", () => {
      closed = true;
    });
    return undefined;
  });
  const { default: plugin } = await import(new URL("agentbus-opencode.js", feature));
  const hooks = await plugin({}, f.env);
  t.after(() => hooks.dispose());
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "root" } } },
  });
  await until(() => waiting);
  await hooks.event({
    event: { type: "session.deleted", properties: { sessionID: "root" } },
  });
  await until(() => closed);
  assert.equal(f.calls.filter((m) => m.method === "agentbus/wait").length, 1);
});

test("OpenCode shares one registration recovery across concurrent transforms", async (t) => {
  let summaries = 0;
  const responses = [];
  const f = await fixture(t, (message, res) => {
    if (message.method === "agentbus/wait") return undefined;
    if (message.method === "agentbus/summary" && ++summaries <= 2) {
      responses.push([message.id, res]);
      if (responses.length === 2) {
        for (const [id, response] of responses) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32004, message: "Session not registered" },
            }),
          );
        }
      }
      return undefined;
    }
    return { context: "restored summary" };
  });
  const { default: plugin } = await import(new URL("agentbus-opencode.js", feature));
  const hooks = await plugin(
    { client: { session: { get: async () => ({ data: { id: "root" } }) } } },
    f.env,
  );
  t.after(() => hooks.dispose());
  const outputs = [{ system: [] }, { system: [] }];
  await Promise.all(
    outputs.map((output) =>
      hooks["experimental.chat.system.transform"]({ sessionID: "root" }, output),
    ),
  );
  assert.ok(outputs.every((output) => output.system.includes("restored summary")));
  assert.equal(f.calls.filter((m) => m.method === "agentbus/register").length, 2);
});
