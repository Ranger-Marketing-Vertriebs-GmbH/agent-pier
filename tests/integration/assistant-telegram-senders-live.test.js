import test from "node:test";
import assert from "node:assert/strict";
import { fixture, people, token } from "../helpers/assistant-telegram-senders-fixture.js";

const bob = people[1];
const carol = { id: "333", name: "Carol" };
const allowFrom = (patch, agent) =>
  patch.patch.channels.telegram.accounts[agent.runtimeAgentId].allowFrom;

/** An agent whose bot the running Gateway was started with. */
async function running(t) {
  const h = fixture(t);
  const agent = h.agent();
  await h.senders.save(agent.id, { token: token(1), people, revision: null });
  h.start();
  return { h, agent };
}

test("removing a person applies live: no restart, no confirmation, access gone", async (t) => {
  const { h, agent } = await running(t);
  const bot = h.senders.store.get(agent.id);
  const view = await h.senders.save(agent.id, { people: [bob], revision: bot.revision });
  assert.equal(h.restarts.length, 0, "the Gateway keeps running");
  assert.equal(h.gateway.patches.length, 1);
  const [patch] = h.gateway.patches;
  assert.deepEqual(allowFrom(patch, agent), ["222"], "Alice is gone");
  assert.deepEqual(patch.replacePaths, [
    `channels.telegram.accounts.${agent.runtimeAgentId}.allowFrom`,
  ]);
  assert.equal(patch.baseHash, "h0", "written against the configuration read");
  assert.doesNotMatch(patch.raw, /fixture-token|Bob/, "neither token nor names");
  // The running Gateway now runs the stored list: nothing pending.
  assert.deepEqual(h.runtime.telegram.people[agent.runtimeAgentId], ["222"]);
  assert.equal(view.pending, false);
  assert.equal(view.pendingLive, false);
  assert.equal(h.senders.revoked(), false);
  assert.deepEqual(
    h.audit.map((e) => e.details.telegram),
    ["connected", "peopleRemoved"],
  );
});

test("adding a person applies live; a new name alone changes nothing", async (t) => {
  const { h, agent } = await running(t);
  let bot = h.senders.store.get(agent.id);
  await h.senders.save(agent.id, { people: [...people, carol], revision: bot.revision });
  assert.deepEqual(allowFrom(h.gateway.patches[0], agent), ["111", "222", "333"]);
  bot = h.senders.store.get(agent.id);
  const renamed = people.map((p) => ({ ...p, name: `${p.name} R.` }));
  await h.senders.save(agent.id, {
    people: [...renamed, carol],
    revision: bot.revision,
  });
  assert.equal(h.gateway.patches.length, 1, "names never reach the Gateway");
  assert.equal(h.restarts.length, 0);
  assert.equal(h.senders.store.get(agent.id).people[0].name, "Alice R.");
});

test("a bot, a token and the last person still restart after confirmation", async (t) => {
  const { h, agent } = await running(t);
  const bot = h.senders.store.get(agent.id);
  await assert.rejects(
    h.senders.save(agent.id, { token: token(2), revision: bot.revision }),
    { code: "ASSISTANT_RESTART_REQUIRED" },
  );
  await assert.rejects(h.senders.save(agent.id, { people: [], revision: bot.revision }), {
    code: "ASSISTANT_RESTART_REQUIRED",
  });
  const other = h.agent("Other");
  await assert.rejects(
    h.senders.save(other.id, { token: token(2), people, revision: null }),
    { code: "ASSISTANT_RESTART_REQUIRED" },
  );
  await assert.rejects(h.senders.remove(agent.id, bot.revision), {
    code: "ASSISTANT_RESTART_REQUIRED",
  });
  assert.equal(h.gateway.patches.length, 0);
  assert.equal(h.senders.store.get(agent.id).revision, bot.revision, "nothing saved");
});

test("a person removed while the Gateway starts is patched in once it answers", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  await h.senders.save(agent.id, { token: token(1), people, revision: null });
  h.starting();
  const started = h.runtime.telegramStarting;
  const bot = h.senders.store.get(agent.id);
  await h.senders.save(agent.id, { people: [bob], revision: bot.revision });
  assert.equal(h.restarts.length, 0, "saved without asking to restart");
  assert.equal((await h.senders.get(agent.id)).pendingLive, true);
  // The start answers with the list it compiled; ready() converges live.
  h.start();
  h.runtime.telegram = h.runtime.telegramStarting = started;
  assert.equal(await h.senders.converge(), true);
  assert.deepEqual(allowFrom(h.gateway.patches[0], agent), ["222"]);
  assert.equal(h.restarts.length, 0);
  assert.equal(h.senders.revoked(), false);
});

test("a refused live patch never leaves a removed person in: it restarts", async (t) => {
  const { h, agent } = await running(t);
  h.gateway.refuse = Object.assign(Error("refused"), { code: "UNAVAILABLE" });
  let bot = h.senders.store.get(agent.id);
  // An addition the Gateway refused stays pending; "Apply now" patches it later.
  const added = await h.senders.save(agent.id, {
    people: [...people, carol],
    revision: bot.revision,
  });
  assert.equal(h.restarts.length, 0);
  assert.equal(added.pending, true);
  assert.equal(added.pendingLive, true);
  h.gateway.refuse = null;
  assert.deepEqual(await h.senders.apply(), { applied: true });
  assert.equal(h.restarts.length, 0, "applied without a restart or confirmation");
  assert.deepEqual(allowFrom(h.gateway.patches.at(-1), agent), ["111", "222", "333"]);
  // A removal the Gateway refused restarts it at once: the person loses access.
  h.gateway.refuse = Object.assign(Error("refused"), { code: "UNAVAILABLE" });
  bot = h.senders.store.get(agent.id);
  await h.senders.save(agent.id, { people: [carol], revision: bot.revision });
  assert.equal(h.restarts.length, 1);
  assert.deepEqual(h.runtime.telegram.people[agent.runtimeAgentId], ["333"]);
  assert.equal(h.senders.revoked(), false);
});
