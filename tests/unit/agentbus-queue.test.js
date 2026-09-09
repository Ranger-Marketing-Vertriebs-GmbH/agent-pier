import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openQueue } from "../../vendor/agentbus/core/queue.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentbus-queue-"));
  const queue = openQueue(home);
  t.after(() => {
    queue.close();
    return fs.rm(home, { recursive: true, force: true });
  });
  return { home, queue };
}

function message(id, ts = 1000, to = "codex-target") {
  return {
    id,
    ts,
    from: {
      runtime: "codex",
      name: "sender",
      sessionId: "sender-session",
      cwd: "/tmp/project",
    },
    to,
    toName: "target",
    text: `message ${id}`,
  };
}

test("queue enqueue is idempotent by message id", async (t) => {
  const { queue } = await fixture(t);
  assert.equal(queue.enqueue(message("01")), "inserted");
  assert.equal(queue.enqueue(message("01", 2000)), "existing");
  assert.equal(queue.summary("codex-target", 2000).count, 1);
});

test("queue claims are exclusive and acknowledgement is owner-scoped", async (t) => {
  const { home, queue } = await fixture(t);
  queue.enqueue(message("01", 1000));
  queue.enqueue(message("02", 1001));
  const other = openQueue(home);
  t.after(() => other.close());
  const first = queue.claim("codex-target", "reader-a", 2000, 1000);
  const second = other.claim("codex-target", "reader-b", 2000, 1000);
  assert.deepEqual(
    first.rows.map((row) => row.id),
    ["01", "02"],
  );
  assert.deepEqual(second.rows, []);
  assert.equal(other.ack("reader-b", first.claimIds), 0);
  assert.equal(queue.ack("reader-a", first.claimIds), 2);
  assert.equal(queue.summary("codex-target", 2000).count, 0);
});

test("expired claims return to the pending queue", async (t) => {
  const { queue } = await fixture(t);
  queue.enqueue(message("01"));
  const first = queue.claim("codex-target", "crashed-reader", 2000, 1000);
  assert.equal(first.rows.length, 1);
  const retry = queue.claim("codex-target", "retry-reader", 3001, 1000);
  assert.deepEqual(
    retry.rows.map((row) => row.id),
    ["01"],
  );
});

test("queue rejects oversized message text", async (t) => {
  const { queue } = await fixture(t);
  assert.throws(
    () => queue.enqueue({ ...message("01"), text: "x".repeat(16 * 1024 + 1) }),
    /16 KiB/,
  );
});
