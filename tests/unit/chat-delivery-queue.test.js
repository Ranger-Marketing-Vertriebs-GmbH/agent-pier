import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DeliveryQueue } from "../../server/features/chat/chat-delivery-queue.js";

function fixture(t, attempt, view) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-queue-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = [];
  const delivery = {
    retryMs: 20,
    waitLimitMs: 1e6,
    active: new Set(),
    requests: { hasPending: () => false },
    sessions: view ? { target: () => "t", tmux: view } : {},
    write: (_file, receipt) =>
      log.push(`write:${receipt.status}/${receipt.reason || ""}`),
    attempt: (job) => attempt(job, log),
  };
  const job = (name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "{}");
    return {
      id: "s",
      file,
      name,
      receipt: { status: "pending", journal: { phase: "reserved" } },
    };
  };
  return { queue: new DeliveryQueue(delivery), log, job };
}

test("only the worker attempts: a held redelivery never runs beside a first attempt", async (t) => {
  const x = fixture(t, async (job, log) => {
    log.push(`start ${job.name}`);
    await sleep(40);
    log.push(`end ${job.name}`);
    return "handed-off";
  });
  const first = x.queue.submit(x.job("A"));
  await sleep(5);
  x.queue.hold(x.job("R"));
  await first;
  await sleep(150);
  assert.deepEqual(x.log, ["start A", "end A", "start R", "end R"]);
});

test("a cancel during the screen read wins: the message is never attempted again", async (t) => {
  let reading = false;
  let attempts = 0;
  const x = fixture(
    t,
    async (job, log) => {
      attempts++;
      log.push(`attempt ${attempts}`);
      job.receipt.waiting = "dialog";
      return "deferred";
    },
    async () => {
      reading = true;
      await sleep(30);
      reading = false;
      return `screen ${Math.random()}`;
    },
  );
  const job = x.job("A");
  await x.queue.submit(job);
  while (attempts < 2) await sleep(1);
  while (!reading) await sleep(1);
  assert.equal(await x.queue.cancel("s", job.file), true);
  await sleep(150);
  assert.deepEqual(x.log, ["attempt 1", "attempt 2", "write:rejected/CHAT_CANCELLED"]);
});

test("a failed cancel write still removes the job from the queue", async (t) => {
  const x = fixture(t, async (job) => {
    job.receipt.waiting = "request";
    return "deferred";
  });
  const job = x.job("A");
  await x.queue.submit(job);
  x.queue.delivery.write = () => {
    throw new Error("disk full");
  };
  await assert.rejects(x.queue.cancel("s", job.file), /disk full/);
  assert.equal(x.queue.busy("s"), false);
});
