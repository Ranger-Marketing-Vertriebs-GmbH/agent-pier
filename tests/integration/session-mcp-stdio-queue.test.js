import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const bridge = new URL("../../server/features/mcp/session-stdio.js", import.meta.url)
  .pathname;

// The session tool bridge against a fake upstream that holds every tools/call open
// until released, recording which calls arrived and which the bridge closed.
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-stdio-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, "s.sock");
  const capability = path.join(dir, "cap.json");
  fs.writeFileSync(capability, JSON.stringify({ token: "fixture-token" }), {
    mode: 0o600,
  });
  const held = new Map();
  const closed = new Set();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body);
      const reply = (result) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      if (message.method !== "tools/call") {
        if (message.id === undefined) return res.writeHead(202).end();
        return reply({ protocolVersion: "2025-03-26" });
      }
      held.set(message.id, () => reply({ content: [] }));
      res.on("close", () => {
        if (!res.writableEnded) closed.add(message.id);
      });
    });
  });
  server.listen(socket);
  await once(server, "listening");
  t.after(() => server.close());
  const child = spawn(
    process.execPath,
    [bridge, "--socket", socket, "--capability", capability],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = once(child, "close");
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  const answered = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line);
    answered.set(response.id, response);
  });
  const write = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  return { held, closed, answered, write };
}

const until = async (check, what) => {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test("a cancellation is honoured while 16 calls run and more wait in the queue", async (t) => {
  const b = await setup(t);
  b.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await until(() => b.answered.has(1), "initialize");
  const call = (id) =>
    b.write({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "agent_ask", arguments: {} },
    });
  for (let id = 100; id < 118; id += 1) call(id);
  await until(() => b.held.size === 16, "16 running calls");
  // Two more wait in the bridge; it still reads stdin and honours the cancellation.
  b.write({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 100, reason: "user" },
  });
  await until(() => b.closed.has(100), "the cancelled upstream request");
  await until(() => b.held.has(116), "the first queued call");
  // A cancelled queued call never starts.
  b.write({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 117, reason: "user" },
  });
  b.held.get(101)();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(b.held.has(117), false);
  for (const [id, release] of b.held) if (id !== 100 && id !== 101) release();
  await until(() => b.answered.size === 1 + 16, "the remaining answers");
  assert.equal(b.answered.has(100), false);
  assert.equal(b.answered.has(117), false);
  assert.ok(b.answered.has(116));
});
