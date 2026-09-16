import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { fixture, launch, descriptor, client, value } from "../helpers/memory.js";
import { memoryResponse } from "../../server/features/memory/memory-protocol.js";

function credential(config) {
  return JSON.parse(
    fs.readFileSync(config.args[config.args.indexOf("--capability") + 1]),
  );
}

test("Memory ignores valid notifications even after capability revocation", async (t) => {
  const f = fixture(t),
    prepared = await launch(f, "notifications", "codex"),
    config = descriptor("codex", prepared),
    grant = credential(config);
  await f.integration.discard("notifications");
  for (const method of [
    "notifications/initialized",
    "tools/call",
    "unknown/notification",
  ])
    assert.equal(
      memoryResponse(f.memory, grant, {
        jsonrpc: "2.0",
        method,
        params: {
          name: "memory_write",
          arguments: { title: "Never", content: "Never", requestId: "notification" },
        },
      }),
      null,
    );
  assert.equal(f.memory.list(prepared.memory.projectId).total, 0);
});

test(
  "Memory reminder is emitted when the native host leaves stdin open",
  { timeout: 6000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      [new URL("../../server/features/memory/memory-hook.js", import.meta.url).pathname],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const done = once(child, "close");
    t.after(async () => {
      child.kill();
      await done;
    });
    let out = "",
      err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.stdin.write('{"partial":');
    const [code] = await done;
    assert.equal(code, 0, err);
    assert.equal(err, "");
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /targeted query/);
  },
);

test("Memory MCP rejects writes without an explicit retry identity before mutation", async (t) => {
  const f = fixture(t),
    prepared = await launch(f, "required-id", "codex"),
    c = client(t, descriptor("codex", prepared));
  await c.initialize();
  const response = await c.call("memory_write", {
    title: "Unsafe retry",
    content: "No identity",
  });
  assert.equal(response.result.isError, true);
  assert.equal(f.memory.list(prepared.memory.projectId).total, 0);
  const listed = await c.request("tools/list");
  assert.ok(
    listed.result.tools
      .find((tool) => tool.name === "memory_write")
      .inputSchema.required.includes("requestId"),
  );
});

test("lost Memory write response can be retried after broker restart without another revision", async (t) => {
  const f = fixture(t),
    prepared = await launch(f, "lost-reply", "codex"),
    config = descriptor("codex", prepared),
    grant = credential(config);
  const original = f.integration.broker.respond;
  let committed;
  const stored = new Promise((resolve) => (committed = resolve));
  f.integration.broker.respond = (...args) => {
    original(...args);
    committed();
    return new Promise(() => {});
  };
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_write",
      arguments: {
        title: "One entry",
        content: "Durable",
        requestId: "same-logical-write",
      },
    },
  };
  const body = JSON.stringify(request);
  const req = http.request({
    socketPath: config.args[config.args.indexOf("--socket") + 1],
    path: "/mcp",
    method: "POST",
    agent: false,
    headers: {
      authorization: `Bearer ${grant.sessionId}.${grant.token}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  });
  req.on("error", () => {});
  req.end(body);
  await stored;
  req.destroy();
  assert.equal(f.memory.list(prepared.memory.projectId).total, 1);
  await f.integration.close();
  f.memory.close();
  const { ProjectMemory } =
    await import("../../server/features/memory/project-memory.js");
  const { MemoryIntegration } =
    await import("../../server/features/memory/memory-integration.js");
  f.memory = new ProjectMemory({ dataDir: f.dataDir });
  f.integration = new MemoryIntegration({ dataDir: f.dataDir, memory: f.memory });
  await f.integration.ready;
  const c = client(t, config);
  await c.initialize();
  const saved = value(await c.call("memory_write", request.params.arguments));
  assert.equal(saved.revision, 1);
  assert.equal(f.memory.list(prepared.memory.projectId).total, 1);
  assert.equal(
    (await c.call("memory_write", { ...request.params.arguments, content: "Different" }))
      .result.isError,
    true,
  );
});

test(
  "Memory reports uncertain committed writes and identical retries recover their result",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      prepared = await launch(f, "slow-write", "codex"),
      c = client(t, descriptor("codex", prepared));
    await c.initialize();
    const original = f.integration.broker.respond;
    let timer,
      attempts = 0;
    t.after(() => clearTimeout(timer));
    f.integration.broker.respond = (...args) => {
      const result = original(...args);
      if (args[1].params?.name === "memory_write" && ++attempts === 1)
        return new Promise((resolve) => {
          timer = setTimeout(() => resolve(result), 6000);
        });
      return result;
    };
    const args = {
      title: "Timed out",
      content: "Still durable",
      requestId: "slow-logical-write",
    };
    const uncertain = await c.call("memory_write", args);
    assert.match(uncertain.error.message, /outcome is unknown/);
    assert.match(uncertain.error.message, /same requestId and identical arguments/);
    assert.equal(attempts, 1);
    assert.equal(f.memory.list(prepared.memory.projectId).total, 1);
    const saved = value(await c.call("memory_write", args));
    assert.equal(saved.revision, 1);
    assert.equal(f.memory.list(prepared.memory.projectId).total, 1);
  },
);

test("Memory large writes receive their committed result through a fresh Unix connection", async (t) => {
  const f = fixture(t),
    prepared = await launch(f, "large-write", "codex"),
    c = client(t, descriptor("codex", prepared));
  await c.initialize();
  const args = {
    title: "Large fixture",
    content: "x".repeat(32000),
    requestId: "large-body",
  };
  assert.equal(value(await c.call("memory_write", args)).content, args.content);
});

test("revoked Memory notifications produce no stdout response in the native MCP relay", async (t) => {
  const f = fixture(t),
    prepared = await launch(f, "native-notification", "codex"),
    c = client(t, descriptor("codex", prepared));
  await c.initialize();
  let output = "";
  c.child.stdout.on("data", (chunk) => (output += chunk));
  await f.integration.discard("native-notification");
  c.child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
  const ping = await c.request("ping");
  assert.ok(ping.error);
  const responses = output.trim().split("\n").map(JSON.parse);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, ping.id);
});
