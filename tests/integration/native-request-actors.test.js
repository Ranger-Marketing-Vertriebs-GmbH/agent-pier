import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-request-actors-"));
  const session = {
    id: "fixture",
    tool: "claude",
    accountId: "account",
    status: "running",
    nativeRequests: { enabled: true },
  };
  const events = [];
  const broker = new RequestBroker({
    dataDir: root,
    sessions: { get: async () => session },
    onEvent: (e) => events.push(e),
  });
  const launch = await broker.prepare({
    id: session.id,
    account: { id: "account", tool: "claude" },
    cwd: root,
    launch: { command: "/fixture/cli", args: [], env: {} },
  });
  const channel = new NativeRequestChannel({ env: launch.env });
  t.after(async () => {
    channel.close();
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await channel.ready;
  return { broker, channel, events };
}
const request = {
  kind: "permission",
  options: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ],
  subject: { command: "fixture command" },
};
async function published(broker, channel, key, delivered = []) {
  channel.publish(key, request, async (answer) => {
    delivered.push(answer);
  });
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    const ask = (await broker.list("fixture")).requests.find((e) => e.revision === 1);
    if (ask) return ask;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Timed out waiting for native request");
}
const answered = (events) => events.filter((e) => e.action === "request.answered");

test("an agent's answer names the agent and its assistantId", async (t) => {
  const { broker, channel, events } = await fixture(t);
  const ask = await published(broker, channel, "native-agent");
  await broker.answer(
    "fixture",
    ask.id,
    { expectedRevision: 1, choice: "allow" },
    false,
    { kind: "agent", assistantId: "a1" },
  );
  const [event] = answered(events);
  assert.equal(event.details.actor, "agent");
  assert.equal(event.details.assistantId, "a1");
  assert.equal(event.details.decision, "allow");
  assert.equal(event.source, "system");
  // The audit keeps both, ids and enums only.
  const audited = auditEvent(event);
  assert.equal(audited.details.actor, "agent");
  assert.equal(audited.details.assistantId, "a1");
});

test("an answer without an actor is the owner's, and Telegram is named", async (t) => {
  const { broker, channel, events } = await fixture(t);
  const ask = await published(broker, channel, "native-owner");
  await broker.answer("fixture", ask.id, { expectedRevision: 1, choice: "deny" });
  const second = await published(broker, channel, "native-telegram");
  await broker.answer(
    "fixture",
    second.id,
    { expectedRevision: 1, choice: "allow" },
    false,
    {
      kind: "telegram",
    },
  );
  const [owner, telegram] = answered(events);
  assert.equal(owner.details.actor, "owner");
  assert.equal("assistantId" in owner.details, false);
  assert.equal(owner.source, "user");
  assert.equal(telegram.details.actor, "telegram");
  assert.equal("assistantId" in telegram.details, false);
  assert.equal(auditEvent(telegram).details.actor, "telegram");
  // A forged actor kind counts as the owner.
  const third = await published(broker, channel, "native-forged");
  await broker.answer(
    "fixture",
    third.id,
    { expectedRevision: 1, choice: "allow" },
    false,
    {
      kind: "root",
      assistantId: "a1",
    },
  );
  const forged = answered(events)[2];
  assert.equal(forged.details.actor, "owner");
  assert.equal("assistantId" in forged.details, false);
});

test("an agent and the owner answering at once: the first answer wins", async (t) => {
  const { broker, channel, events } = await fixture(t);
  const delivered = [];
  const ask = await published(broker, channel, "native-race", delivered);
  const results = await Promise.allSettled([
    broker.answer("fixture", ask.id, { expectedRevision: 1, choice: "allow" }, false, {
      kind: "agent",
      assistantId: "a1",
    }),
    broker.answer("fixture", ask.id, { expectedRevision: 1, choice: "deny" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.deepEqual(delivered, [{ choice: "allow" }]);
  assert.equal(answered(events).length, 1);
  assert.equal(answered(events)[0].details.actor, "agent");
  // The loser learns who claimed the prompt.
  const lost = results.find((r) => r.status === "rejected").reason;
  assert.equal(lost.status, 409);
  assert.equal(lost.stale, true);
  assert.equal(lost.answeredBy, "agent");
  // Neither the list nor the inbox shows who is claiming.
  assert.equal((await broker.list("fixture")).requests.length, 0);
  assert.equal(JSON.stringify(broker.listAll()).includes("claimedBy"), false);
});
