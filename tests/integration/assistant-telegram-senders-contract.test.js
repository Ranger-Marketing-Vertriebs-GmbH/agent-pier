import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  telegramSendersGateway,
  transcript,
} from "../helpers/assistant-telegram-senders-gateway.js";

// Qualifies OpenClaw 2026.9.8 for agents' own Telegram bots on AgentPier's compiled
// path (openclaw-config/telegram-senders.js): per-account bindings, allowlists,
// per-sender sessions, refused directives and AgentPier tools, Deepgram voice notes
// with the speech key, and the owner's own conversations unaffected. Telegram and
// Deepgram are loopback fakes; no request leaves the machine.
const installed = process.env.AGENTPIER_TELEGRAM_SENDERS_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_TELEGRAM_SENDERS_CONTRACT_RUNTIME",
  timeout: contractTimeout(600000),
};
const token1 = "7001:fixture-token-one-abcdefghijklmnopqrstuvwxyz";
const token2 = "7002:fixture-token-two-abcdefghijklmnopqrstuvwxyz";
const token3 = "7003:fixture-token-three-abcdefghijklmnopqrstuvwxyz";
const bots = {
  [token1]: { id: 7001, username: "helper_fixture_bot" },
  [token2]: { id: 7002, username: "second_fixture_bot" },
  [token3]: { id: 7003, username: "third_fixture_bot" },
};
const alice = { id: "111", name: "Alice" };
const bob = { id: "222", name: "Bob" };
const carol = { id: "333", name: "Carol" };

test("agents' own bots on the compiled path", options, async (t) => {
  const h = await telegramSendersGateway(t, installed, {
    prefix: "telegram-senders-",
    bots,
  });
  const helper = h.create("Helper", { capabilities: { memory: true, reminders: false } });
  const second = h.create("Second");
  const third = h.create("Third");
  const owner = h.create("Owner");
  await h.runtime.start();
  for (const agent of [helper, second, third, owner]) await h.config.apply(agent.id);
  h.speech.save({ apiKey: "dg-fixture-key", language: "de", revision: 0 });

  // A save the running Gateway was not started with asks first, then restarts it.
  const ask = { token: token1, people: [alice, bob], revision: null };
  await assert.rejects(h.senders.save(helper.id, ask), {
    code: "ASSISTANT_RESTART_REQUIRED",
  });
  await h.senders.save(helper.id, ask, { confirmed: true });
  await h.senders.save(
    second.id,
    { token: token2, people: [carol], revision: null },
    { confirmed: true },
  );
  await h.senders.save(
    third.id,
    { token: token3, people: [carol], revision: null },
    { confirmed: true },
  );
  assert.equal(h.restarts.length, 3);
  const ids = (agent) => h.store.getAssistant(agent.id).runtimeAgentId;
  const running = await h.running();
  t.diagnostic(`telegram=${JSON.stringify(running.channels.telegram)}`);
  assert.deepEqual(
    Object.keys(running.channels.telegram.accounts).sort(),
    [ids(helper), ids(second), ids(third)].sort(),
  );
  const account = running.channels.telegram.accounts[ids(helper)];
  assert.deepEqual(account.allowFrom, ["111", "222"]);
  assert.notEqual(account.botToken, token1, "config.get redacts the token");
  assert.deepEqual(running.session, { dmScope: "per-account-channel-peer" });
  assert.deepEqual(running.tools.agentToAgent, { enabled: false });
  assert.ok(running.plugins.allow.includes("telegram"));
  assert.ok(running.plugins.allow.includes("deepgram"));
  assert.equal(running.bindings.length, 3);
  await h.polling(token1, token2, token3);
  const status = await h.senders.get(helper.id);
  assert.equal(status.status.state, "running");
  assert.doesNotMatch(JSON.stringify(status), /fixture-token/);

  // An allowed sender reaches the agent of this bot and gets the reply there.
  h.bots.text(token1, bob, "hello [m:bob1]");
  await h.until(() => h.bots.sent(token1, bob.id).length, "reply to Bob");
  assert.equal(h.requests("[m:bob1]").length >= 1, true);
  // Carol may write to the second agent only: the helper's bot ignores her.
  h.bots.text(token1, carol, "let me in [m:carol1]");
  h.bots.text(token2, carol, "hello second [m:carol2]");
  await h.until(() => h.bots.sent(token2, carol.id).length, "reply to Carol");
  await delay(3000);
  assert.equal(h.requests("[m:carol1]").length, 0, "not on the allowlist");
  assert.equal(h.bots.sent(token1, carol.id).length, 0);
  // Each sender has a conversation of their own with the bot's agent.
  h.bots.text(token1, alice, "hello [m:alice1]");
  await h.until(() => h.bots.sent(token1, alice.id).length, "reply to Alice");
  const helperSessions = await h.sessions(ids(helper));
  t.diagnostic(`sessions=${JSON.stringify(helperSessions)}`);
  for (const person of [alice, bob])
    assert.ok(
      helperSessions.includes(
        `agent:${ids(helper)}:telegram:${ids(helper)}:direct:${person.id}`,
      ),
    );
  assert.ok(
    (await h.sessions(ids(second))).includes(
      `agent:${ids(second)}:telegram:${ids(second)}:direct:${carol.id}`,
    ),
  );
  assert.equal(
    JSON.stringify(h.requests("[m:alice1]")).includes("[m:bob1]"),
    false,
    "Alice's conversation does not contain Bob's",
  );

  // Senders run no commands or directives: OpenClaw refuses them before the model,
  // so no status, thinking level or session reset reaches them.
  const before = h.bots.calls.length;
  const asked = h.model.requests.length;
  for (const text of ["/status", "/think high", "/new", "/model fixture/x"])
    h.bots.text(token1, alice, text);
  await delay(8000);
  const replies = h.bots.calls
    .slice(before)
    .filter((c) => c.method === "sendMessage")
    .map((c) => String(c.params.text));
  t.diagnostic(`command replies=${JSON.stringify(replies)}`);
  assert.equal(h.model.requests.length, asked, "no model turn for a command");
  assert.equal(
    replies.some((text) => /OpenClaw 2026|Thinking level|New session|Model/.test(text)),
    false,
  );
  // AgentPier's own tools refuse a turn AgentPier did not start.
  h.bots.text(token1, alice, "check the team [tool:agentpier_team_status]");
  const toolTurn = await h.until(
    () =>
      h
        .requests("[tool:agentpier_team_status]")
        .flatMap((r) => r.messages)
        .find((m) => m.role === "tool"),
    "tool result",
  );
  t.diagnostic(`tool=${JSON.stringify(String(toolTurn.content)).slice(0, 400)}`);
  assert.doesNotMatch(String(toolTurn.content), /Validation failed/);
  assert.match(String(toolTurn.content), /FORBIDDEN/);

  // A voice note is transcribed by Deepgram with the speech settings' key.
  h.bots.voice(token1, alice, "voice-1", Buffer.alloc(4096, 7));
  await h.until(() => h.requests(transcript).length, "voice transcript");
  assert.equal(h.deepgram.requests.length, 1);
  assert.equal(h.deepgram.requests[0].authorization, "Token dg-fixture-key");
  assert.match(h.deepgram.requests[0].url, /model=nova-3/);
  assert.match(h.deepgram.requests[0].url, /language=de/);

  // Senders get no session tools: no status card, no other sessions. The owner's
  // own agents keep them.
  h.bots.text(token1, bob, "status please [tool:session_status]");
  await h.until(() => h.requests("[tool:session_status]").length, "session tool turn");
  await delay(2000);
  const sessionTurn = h.requests("[tool:session_status]");
  const offeredToSender = sessionTurn[0].tools.map((d) => d.function.name);
  t.diagnostic(`sender tools=${JSON.stringify(offeredToSender)}`);
  assert.equal(offeredToSender.includes("session_status"), false);
  assert.equal(
    sessionTurn.flatMap((r) => r.messages).some((m) => m.role === "tool"),
    false,
    "no session tool ran",
  );
  assert.equal(
    (await h.running()).agents.entries[ids(helper)].tools.allow.includes(
      "session_status",
    ),
    false,
  );

  // Group chats never reach the agent, even from an allowed person.
  h.bots.group(token1, alice, -1001234567890, "hello group [m:group]");
  await delay(4000);
  assert.equal(h.requests("[m:group]").length, 0);
  assert.equal(h.bots.sent(token1, -1001234567890).length, 0);

  // The owner's own conversations are unaffected, including a team run.
  const turn = await h.ownerTurn(owner, "o1");
  assert.equal(turn.status, "ok");
  assert.ok(turn.requests.length >= 1);
  assert.ok(turn.requests[0].tools.some((d) => d.function.name === "session_status"));
  const team = await h.ownerTurn(owner, "o2", "[tool:agentpier_team_propose]");
  t.diagnostic(`team tools=${JSON.stringify(team.tools)}`);
  assert.equal(team.status, "ok");
  assert.ok(team.tools.includes("agentpier_team_propose"));
  assert.equal(h.teams.store.list().length, 1);
  assert.equal(h.teams.store.list()[0].phase, "awaiting_approval");

  // A check-in of an agent with its own bot (as native-heartbeats.js schedules it:
  // announce into its AgentPier conversation, completion by webhook) never goes out
  // through the bot: the configured Telegram account is no announce route for it.
  const completions = [];
  const hook = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    completions.push(body);
    res.writeHead(200).end("{}");
  });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => hook.close(r)));
  const checkIn = await h.runtime.client.call("sessions.create", {
    agentId: ids(helper),
    label: "AgentPier check-in fixture",
  });
  const added = await h.runtime.client.call("cron.add", {
    name: "AgentPier check-in",
    agentId: ids(helper),
    enabled: true,
    deleteAfterRun: false,
    schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
    payload: {
      kind: "agentTurn",
      message: "Check in. [m:checkin]",
      timeoutSeconds: 120,
      lightContext: false,
      toolsAllow: ["memory_search", "memory_get"],
    },
    sessionTarget: "current",
    sessionKey: checkIn.key,
    wakeMode: "now",
    failureAlert: false,
    delivery: {
      mode: "announce",
      completionDestination: {
        mode: "webhook",
        to: `http://127.0.0.1:${hook.address().port}/complete/fixture`,
      },
    },
  });
  const job = added?.job || added;
  const sentBefore = h.bots.calls.filter((c) => c.method === "sendMessage").length;
  await h.runtime.client.call("cron.run", { id: job.id, mode: "force" });
  await h.until(
    async () =>
      (await h.runtime.client.call("cron.runs", { id: job.id, limit: 5 })).entries.some(
        (e) => e.action === "finished",
      ),
    "check-in finished",
    { timeoutMs: 90000 },
  );
  await delay(3000);
  assert.ok(h.requests("[m:checkin]").length >= 1, "the check-in ran");
  assert.equal(
    h.bots.calls.filter((c) => c.method === "sendMessage").length,
    sentBefore,
    "no check-in output through the agent's own bot",
  );
  t.diagnostic(`check-in completions=${completions.length}`);
  await h.runtime.client.call("cron.remove", { id: job.id });

  // A second poller of a bot (409) leaves the Gateway and the other bots running.
  h.bots.conflict(token2);
  await h.until(
    async () => (await h.senders.get(second.id)).status.state === "error",
    "conflict reported",
    { timeoutMs: 90000 },
  );
  h.bots.text(token1, bob, "still there [m:bob409]");
  await h.until(() => h.requests("[m:bob409]").length, "helper after a conflict");
  assert.equal((await h.ownerTurn(owner, "o3")).status, "ok");

  // An agent with a bot keeps shell off.
  await assert.rejects(
    h.assistants.update(
      helper.id,
      { shell: "approval", confirmShell: true },
      h.store.getAssistant(helper.id).revision,
    ),
    { status: 409, key: "telegramSendersShell" },
  );

  // Disconnecting the second bot stops its polling at the restart.
  const current = (await h.senders.get(second.id)).bot;
  await h.senders.remove(second.id, current.revision, { confirmed: true });
  assert.deepEqual(
    Object.keys((await h.running()).channels.telegram.accounts).sort(),
    [ids(helper), ids(third)].sort(),
  );
  await h.polling(token1);
  const polls = h.bots.polls(token2);
  await delay(4000);
  assert.equal(h.bots.polls(token2), polls, "the removed bot is not polled");

  // A token Telegram revoked (401) never stops the Gateway: it starts, the owner's
  // agents and the other bot keep working and the bot shows an error.
  h.bots.reject(token3);
  await h.runtime.restart();
  assert.equal(h.runtime.status().availability, "ready");
  assert.equal((await h.ownerTurn(owner, "o4")).status, "ok");
  h.bots.text(token1, alice, "after a revoked token [m:alice401]");
  await h.until(() => h.requests("[m:alice401]").length, "helper after 401");
  await h.until(
    async () => (await h.senders.get(third.id)).status.state === "error",
    "revoked token reported",
    { timeoutMs: 90000 },
  );

  // Neither the tokens nor the Deepgram key reach the Gateway's logs.
  const logs = fs
    .readdirSync(h.runtime.paths.logs)
    .map((name) => fs.readFileSync(path.join(h.runtime.paths.logs, name), "utf8"))
    .join("\n");
  for (const secret of [token1, token2, token3, "fixture-token", "dg-fixture-key"])
    assert.equal(logs.includes(secret), false, "secret in a log");
  assert.doesNotMatch(JSON.stringify(h.audit), /fixture-token|dg-fixture-key|Alice/);
});
