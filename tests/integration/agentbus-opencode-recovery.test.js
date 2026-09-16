import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";

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

test("OpenCode retries notices beyond five failures with capped backoff", async (t) => {
  let waits = 0;
  const f = await fixture(t, (message, res) => {
    if (message.method !== "agentbus/wait") return {};
    waits++;
    if (waits <= 8) {
      res.destroy();
      return undefined;
    }
    return waits === 9
      ? { notifications: [{ nativeSessionId: "root", text: "recovered notice" }] }
      : undefined;
  });
  const { default: plugin } = await import(new URL("agentbus-opencode.js", feature));
  const prompts = [];
  const hooks = await plugin(
    { client: { session: { promptAsync: async (v) => prompts.push(v) } } },
    f.env,
  );
  t.after(() => hooks.dispose());
  const realTimeout = setTimeout;
  const settle = () => new Promise((resolve) => realTimeout(resolve, 10));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "root" } } },
  });
  for (let attempt = 1; attempt <= 8; attempt++) {
    for (let i = 0; i < 100 && waits < attempt; i++) await settle();
    assert.equal(waits, attempt);
    await settle();
    t.mock.timers.tick(249);
    await settle();
    assert.equal(waits, attempt, "Failures must not spin without a delay");
    t.mock.timers.tick(4751);
  }
  for (let i = 0; i < 100 && prompts.length === 0; i++) await settle();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].body.parts[0].text, "recovered notice");
  await hooks.dispose();
  const count = waits;
  t.mock.timers.tick(60000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waits, count);
  await settle();
});

test("OpenCode disposal cancels a scheduled reconnect", async (t) => {
  let waits = 0;
  const f = await fixture(t, (message, res) => {
    if (message.method !== "agentbus/wait") return {};
    waits++;
    res.destroy();
    return undefined;
  });
  const { default: plugin } = await import(new URL("agentbus-opencode.js", feature));
  const hooks = await plugin({}, f.env);
  t.after(() => hooks.dispose());
  const realTimeout = setTimeout;
  const settle = () => new Promise((resolve) => realTimeout(resolve, 10));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "root" } } },
  });
  for (let i = 0; i < 100 && waits === 0; i++) await settle();
  await settle();
  assert.equal(waits, 1);
  await hooks.dispose();
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(waits, 1);
});
