import test from "node:test";
import assert from "node:assert/strict";
import { busFixture, requestBus } from "../helpers/agentbus-broker.js";
import { nudgeText } from "../../vendor/agentbus/core/nudge.js";

const refusalHint = /do not retry; tell the user or wait for their instruction/i;

async function registered(f, id) {
  const result = await f.prepare(id);
  const response = await requestBus(result.launch.env, "agentbus/register", {
    nativeSessionId: `native-${id}`,
    pid: result.native.pid,
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  return result;
}

// Two or three registered peers share one project queue, a fake clock and a
// recorder for wakes and refusal log lines; no test waits on real time.
async function budgetFixture(t, ids = ["alpha", "beta"]) {
  const f = await busFixture(t);
  const peers = {};
  for (const id of ids) peers[id] = await registered(f, id);
  const broker = f.bus.broker;
  const clock = { now: Date.now() };
  broker.now = () => clock.now;
  const logs = [];
  broker.log = (line) => logs.push(line);
  let wakes = 0;
  const schedule = broker.scheduleWake.bind(broker);
  broker.scheduleWake = (...args) => {
    wakes += 1;
    return schedule(...args);
  };
  const keys = {};
  for (const id of ids) {
    const other = ids.find((candidate) => candidate !== id);
    const listing = await call(peers[other], "peers_list");
    keys[id] = listing.result.content[0].text.match(
      new RegExp(`\\(key ([^)]*${id}[^)]*)\\)`),
    )?.[1];
  }
  const send = async (from, to, text, replyTo) => {
    const response = await call(peers[from], "peer_send", {
      to: keys[to],
      text,
      ...(replyTo ? { replyTo } : {}),
    });
    assert.equal(response.error, undefined, JSON.stringify(response));
    const body = response.result.content[0].text;
    if (response.result.isError) return { refused: JSON.parse(body) };
    return { id: body.match(/\(id ([^)]+)\)/)[1] };
  };
  const stored = () =>
    f.bus.queue(broker.access.record(peers[ids[0]].id).h).rows({}).length;
  return {
    f,
    clock,
    logs,
    send,
    stored,
    wakes: () => wakes,
    drain: () => broker.drainWakes(),
  };
}

const call = (session, name, args = {}) =>
  requestBus(session.launch.env, "tools/call", {
    name,
    arguments: { ...args, __agentpierSession: `native-${session.id}` },
  });

test("a scripted reply loop stops at the reply depth limit for both peers", async (t) => {
  const b = await budgetFixture(t);
  let last;
  for (let turn = 0; turn < 12; turn += 1) {
    b.clock.now += 30000;
    const result = await b.send(
      turn % 2 ? "beta" : "alpha",
      turn % 2 ? "alpha" : "beta",
      `Turn ${turn}`,
      last,
    );
    assert.ok(result.id, `turn ${turn} is ordinary coordination`);
    last = result.id;
  }
  const storedBefore = b.stored();
  await b.drain();
  const wakesBefore = b.wakes();
  b.clock.now += 30000;
  const alpha = await b.send("alpha", "beta", "Private loop text", last);
  const beta = await b.send("beta", "alpha", "Private loop text", last);
  for (const result of [alpha, beta]) {
    assert.equal(result.refused.code, "SEND_BUDGET");
    assert.match(result.refused.message, /reply chain/);
    assert.match(
      result.refused.message,
      /new thread without replyTo only if the user asked/,
    );
    assert.match(result.refused.message, /12/);
    assert.match(result.refused.message, refusalHint);
  }
  assert.equal(b.stored(), storedBefore, "refusals store nothing");
  assert.equal(b.wakes(), wakesBefore, "refusals send no wake");
  assert.equal(b.logs.length, 2);
  for (const line of b.logs) {
    assert.match(line, /SEND_BUDGET/);
    assert.match(line, /depth/);
    assert.doesNotMatch(line, /Private loop text/);
  }
  const fresh = await b.send("alpha", "beta", "A new thread");
  assert.ok(fresh.id, "a new thread without replyTo is not limited by depth");
});

test("a loop without replyTo stops at the pair limit and resets after ten minutes", async (t) => {
  const b = await budgetFixture(t);
  for (let turn = 0; turn < 20; turn += 1) {
    b.clock.now += 15000;
    const from = turn % 2 ? "beta" : "alpha";
    const result = await b.send(from, turn % 2 ? "alpha" : "beta", `Ping ${turn}`);
    assert.ok(result.id, `turn ${turn} stays within budget`);
  }
  await b.drain();
  const storedBefore = b.stored();
  const wakesBefore = b.wakes();
  b.clock.now += 15000;
  const alpha = await b.send("alpha", "beta", "Private ping");
  const beta = await b.send("beta", "alpha", "Private ping");
  for (const result of [alpha, beta]) {
    assert.equal(result.refused.code, "SEND_BUDGET");
    assert.match(result.refused.message, /10 messages/);
    assert.match(result.refused.message, /10 minutes/);
    assert.match(result.refused.message, refusalHint);
  }
  assert.equal(b.stored(), storedBefore);
  assert.equal(b.wakes(), wakesBefore);
  assert.equal(b.logs.length, 2);
  assert.ok(b.logs.every((line) => /pair/.test(line) && !/Private ping/.test(line)));
  b.clock.now += 10 * 60000;
  assert.ok((await b.send("alpha", "beta", "Later")).id, "the pair window resets");
});

test("a sender may send six messages per minute across its peers", async (t) => {
  const b = await budgetFixture(t, ["alpha", "beta", "gamma"]);
  for (let index = 0; index < 6; index += 1) {
    const result = await b.send("alpha", index % 2 ? "gamma" : "beta", `Burst ${index}`);
    assert.ok(result.id);
  }
  const refused = await b.send("alpha", "gamma", "One more");
  assert.equal(refused.refused.code, "SEND_BUDGET");
  assert.match(refused.refused.message, /6 messages in the last minute/);
  assert.match(refused.refused.message, /Wait 60 seconds before sending again/);
  assert.doesNotMatch(refused.refused.message, refusalHint, "a burst only has to wait");
  b.clock.now += 20500;
  const later = await b.send("alpha", "gamma", "Still too early");
  assert.match(later.refused.message, /Wait 40 seconds before sending again/);
  assert.ok((await b.send("beta", "alpha", "Other senders keep their budget")).id);
  b.clock.now += 39501;
  assert.ok((await b.send("alpha", "gamma", "Next minute")).id, "the minute resets");
});

test("every wake text asks for a reply only when one is needed", () => {
  for (const runtime of ["claude", "codex", "opencode"])
    assert.match(
      nudgeText(1, "peer", runtime, "id1"),
      /antworte bei Bedarf mit peer_send/,
    );
  assert.match(nudgeText(1, "peer", "claude", "id1"), /nicht mit SendMessage/);
});
