import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { busFixture } from "../helpers/agentbus-broker.js";

test("a lost peer_send response warns of uncertain delivery and is never replayed", async (t) => {
  const f = await busFixture(t);
  const session = await f.prepare("uncertain-sender");
  const handle = f.bus.broker.transport.handle.bind(f.bus.broker.transport);
  let requests = 0;
  t.mock.method(f.bus.broker.transport, "handle", (req, res) => {
    if (!requests++) return handle(req, res);
    req.resume();
    req.once("end", () => res.destroy());
  });
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../server/features/agentbus/agentbus-mcp.js", import.meta.url),
      ),
    ],
    {
      env: { PATH: process.env.PATH, ...session.launch.env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stderr.resume();
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  t.after(async () => {
    child.kill();
    await exited;
  });
  const request = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return JSON.parse((await lines.next()).value);
  };
  assert.ok((await request(1, "initialize", {})).result);
  const result = await request(2, "tools/call", {
    name: "peer_send",
    arguments: { to: "peer", text: "message" },
  });
  assert.match(result.error.message, /may have (?:been sent|succeeded)/i);
  assert.match(
    result.error.message,
    /do not (?:automatically resend|resend automatically)/i,
  );
  assert.doesNotMatch(result.error.message, /then retry/i);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests, 2, "Only initialization and the original send reach the broker");
});
