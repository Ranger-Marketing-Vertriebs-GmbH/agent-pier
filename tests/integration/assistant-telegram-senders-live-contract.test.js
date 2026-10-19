import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { telegramSendersGateway } from "../helpers/assistant-telegram-senders-gateway.js";

// Qualifies the pinned OpenClaw runtime for live allowlist changes of agents' own
// Telegram bots (AGENTPIER-52): `channels.telegram.accounts.<id>.allowFrom` written
// through config.patch with replacePaths takes effect at the next inbound message,
// without a Gateway restart and without interrupting the bot's polling. Telegram is
// the loopback Bot API fake; no request leaves the machine.
const installed = process.env.AGENTPIER_TELEGRAM_SENDERS_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_TELEGRAM_SENDERS_CONTRACT_RUNTIME",
  timeout: contractTimeout(600000),
};
const token1 = "7101:fixture-token-live-abcdefghijklmnopqrstuvwxyz";
const bots = { [token1]: { id: 7101, username: "live_fixture_bot" } };
const alice = { id: "111", name: "Alice" };
const bob = { id: "222", name: "Bob" };
const carol = { id: "333", name: "Carol" };

test("allowed people change live on the pinned runtime", options, async (t) => {
  const h = await telegramSendersGateway(t, installed, {
    prefix: "telegram-live-",
    bots,
  });
  const helper = h.create("Helper");
  await h.runtime.start();
  await h.config.apply(helper.id);
  // The first bot enables the Telegram plugin: that still restarts once.
  await h.senders.save(
    helper.id,
    { token: token1, people: [alice, bob], revision: null },
    { confirmed: true },
  );
  assert.equal(h.restarts.length, 1);
  await h.polling(token1);
  const id = h.store.getAssistant(helper.id).runtimeAgentId;
  h.bots.text(token1, bob, "hello [m:bob1]");
  await h.until(() => h.bots.sent(token1, bob.id).length, "reply to Bob");
  const generation = h.runtime.generation;
  const pid = h.runtime.child?.pid;

  // Removing Bob: no confirmation, no restart, and his next message is ignored.
  let bot = (await h.senders.get(helper.id)).bot;
  const removed = await h.senders.save(helper.id, {
    people: [alice],
    revision: bot.revision,
  });
  assert.equal(h.restarts.length, 1, "no Gateway restart");
  assert.equal(h.runtime.generation, generation);
  assert.equal(h.runtime.child?.pid, pid, "the same Gateway process");
  assert.equal(removed.pending, false);
  assert.deepEqual((await h.running()).channels.telegram.accounts[id].allowFrom, ["111"]);
  const repliesToBob = h.bots.sent(token1, bob.id).length;
  h.bots.text(token1, bob, "still here? [m:bob2]");
  h.bots.text(token1, alice, "hello [m:alice1]");
  await h.until(() => h.bots.sent(token1, alice.id).length, "reply to Alice");
  await delay(4000);
  assert.equal(h.requests("[m:bob2]").length, 0, "Bob no longer reaches the agent");
  assert.equal(h.bots.sent(token1, bob.id).length, repliesToBob, "and gets no reply");

  // Adding Carol: her first message reaches the agent, still without a restart.
  bot = (await h.senders.get(helper.id)).bot;
  await h.senders.save(helper.id, { people: [alice, carol], revision: bot.revision });
  h.bots.text(token1, carol, "hello [m:carol1]");
  await h.until(() => h.bots.sent(token1, carol.id).length, "reply to Carol");
  assert.equal(h.restarts.length, 1);
  assert.equal(h.runtime.child?.pid, pid);
  const status = await h.senders.get(helper.id);
  assert.equal(status.status.state, "running");
  assert.equal(status.pending, false);
});
