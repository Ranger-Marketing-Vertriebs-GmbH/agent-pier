import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { openQueue } from "../../vendor/agentbus/core/queue.js";

const execute = promisify(execFile);
const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
const moduleUrl = new URL("../../vendor/agentbus/core/queue.js", import.meta.url).href;

test(
  "Node and Bun share durable messages, exclusive claims and crash recovery",
  {
    skip:
      bun.error?.code === "ENOENT" ? "Bun compatibility runs in the CI matrix" : false,
  },
  async (t) => {
    assert.equal(bun.status, 0, bun.stderr);
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentbus-runtimes-"));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const queue = openQueue(home);
    t.after(() => queue.close());
    const message = {
      id: "runtime-message",
      ts: 1000,
      from: { runtime: "codex", name: "Node", sessionId: "sender", cwd: home },
      to: "opencode-target",
      toName: "Bun",
      text: "Shared queue ünicode",
    };
    async function call(method, ...args) {
      const script = `
      import { openQueue } from ${JSON.stringify(moduleUrl)};
      const queue = openQueue(process.argv[1]);
      try {
        console.log(JSON.stringify(queue[process.argv[2]](...JSON.parse(process.argv[3]))));
      } finally { queue.close(); }
    `;
      const { stdout } = await execute(
        "bun",
        ["--eval", script, home, method, JSON.stringify(args)],
        { timeout: 10000 },
      );
      return JSON.parse(stdout);
    }
    assert.equal(queue.enqueue(message), "inserted");
    assert.equal(await call("enqueue", message), "existing");
    assert.equal((await call("summary", message.to, 2000)).count, 1);
    const claim = await call("claim", message.to, "bun-reader", 2000, 1000);
    assert.equal(claim.rows[0].text, message.text);
    assert.deepEqual(queue.claim(message.to, "node-reader", 2000, 1000).rows, []);
    assert.equal(queue.ack("node-reader", claim.claimIds), 0);
    // The Bun process exited without acknowledging; Node recovers its expired lease.
    const recovered = queue.claim(message.to, "node-reader", 3001, 1000);
    assert.deepEqual(recovered.claimIds, [message.id]);
    assert.equal(await call("ack", "bun-reader", recovered.claimIds), 0);
    assert.equal(queue.ack("node-reader", recovered.claimIds), 1);
    assert.equal((await call("summary", message.to, 3001)).count, 0);
    const reverse = { ...message, id: "bun-message", to: "codex-target" };
    assert.equal(await call("enqueue", reverse), "inserted");
    const nodeClaim = queue.claim(reverse.to, "node-reader", 4000, 1000);
    assert.equal(nodeClaim.rows[0].text, reverse.text);
    assert.equal(await call("ack", "node-reader", nodeClaim.claimIds), 1);
    assert.equal(queue.summary(reverse.to, 4000).count, 0);
  },
);
