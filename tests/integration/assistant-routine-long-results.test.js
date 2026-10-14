import test from "node:test";
import assert from "node:assert/strict";
import { routineFixture } from "../helpers/native-routines-fixture.js";
import { NativeHeartbeats } from "../../server/features/assistants/native-heartbeats.js";
import { summaryCap } from "../../server/features/assistants/cron-result-text.js";
import { conversationHistory } from "../../server/features/assistants/conversations.js";
import { telegramMessage } from "../helpers/assistant-channel-fixture.js";

// A news digest well beyond Telegram's 4096 and OpenClaw's 2000-character summary:
// sections with bold headings and a source link each.
const digest = Array.from(
  { length: 18 },
  (_, n) =>
    `**Section ${n + 1}: model news**\n` +
    `Item ${n + 1} describes what changed today in some detail, so that the digest grows. `.repeat(
      3,
    ) +
    `[Quelle: Example ${n + 1}](https://news.example/${n + 1})`,
).join("\n\n");
// OpenClaw's pickSummaryFromOutput: the trimmed reply, capped with an ellipsis.
const capped = (text) => `${text.slice(0, summaryCap)}…`;

// OpenClaw's Gateway: the job's own session key serves the latest run's transcript,
// naming that run's session id.
function gateway(f, runSession, reply = digest) {
  const original = f.assistants.runtime.client.call;
  const [, jobSession, sessionId] = /^(.*):run:([^:]+)$/.exec(runSession);
  const reads = [];
  const state = { sessionId };
  f.assistants.runtime.client.call = async (method, input) => {
    if (method !== "chat.history") return original(method, input);
    reads.push(input);
    await reads.during?.();
    if (input.sessionKey !== jobSession) throw Error("unknown session");
    return {
      sessionKey: jobSession,
      sessionId: state.sessionId,
      messages: [
        { role: "user", content: [{ type: "text", text: "Routine prompt" }] },
        { role: "assistant", content: [{ type: "toolCall", name: "web_fetch" }] },
        { role: "assistant", content: [{ type: "text", text: reply }] },
      ],
    };
  };
  reads.state = state;
  return reads;
}
function telegram(f) {
  const sends = [];
  f.client.call = async (method, params) => {
    assert.equal(method, "sendMessage");
    sends.push(params);
    return { message_id: sends.length, chat: { id: 42 } };
  };
  return sends;
}
const deliver = async (f) => {
  for (let n = 0; n < 3; n++)
    await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
};

test("a routine result OpenClaw capped reaches Telegram in full, in order, in several messages", async (t) => {
  assert.ok(digest.length > 4096);
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, f.input);
  const jobId = f.reminders.bindings.get(routine.id).nativeId;
  const agent = f.store.getAssistant(f.id).runtimeAgentId;
  const runSession = `agent:${agent}:cron:${jobId}:run:run-1`;
  const reads = gateway(f, runSession);
  const sends = telegram(f);
  await f.reminders.complete(routine.id, {
    jobId,
    runAtMs: 1000,
    status: "ok",
    summary: capped(digest),
    deliveryStatus: "delivered",
    sessionKey: runSession,
  });
  assert.deepEqual(
    [...reads],
    [
      {
        sessionKey: `agent:${agent}:cron:${jobId}`,
        limit: 50,
        maxChars: 65536,
      },
    ],
  );
  const [entry] = f.service.outbox.all(f.channel.id);
  assert.equal(entry.text, digest, "the full reply, not the capped summary");
  assert.ok(entry.parts.length > 1);
  // The chat's badge matches the committed reply, which is the full text.
  const [result] = f.routines.results.forConversation(f.channel.conversationId);
  assert.equal(result.text, digest);

  await deliver(f);
  assert.equal(sends.length, entry.parts.length);
  const ids = f.service.outbox.get(entry.id);
  assert.equal(ids.state, "delivered");
  assert.deepEqual(
    ids.remoteMessageIds,
    sends.map((_, n) => n + 1),
  );
  for (const send of sends) {
    assert.equal(send.parse_mode, "HTML");
    assert.ok(send.text.length <= 4000);
    // No part ends inside a link or with raw Markdown link syntax.
    assert.doesNotMatch(send.text, /\[Q/);
    assert.equal(
      (send.text.match(/<a /g) || []).length,
      (send.text.match(/<\/a>/g) || []).length,
    );
  }
  const joined = sends.map((s) => s.text).join("\n\n");
  for (let n = 1; n <= 18; n++)
    assert.ok(
      joined.includes(`<a href="https://news.example/${n}">Quelle: Example ${n}</a>`),
      `link ${n} intact`,
    );
  // In order: each part starts where the previous one ended.
  const sections = joined.match(/Section \d+/g).map((s) => Number(s.split(" ")[1]));
  assert.deepEqual(
    sections,
    Array.from({ length: 18 }, (_, n) => n + 1),
  );
  // Parts break between sections, not inside one.
  for (const send of sends.slice(1)) assert.match(send.text, /^<b>Section \d+/);
});

test("a capped summary stays the fallback when the run's reply cannot be proven", async (t) => {
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, f.input);
  const jobId = f.reminders.bindings.get(routine.id).nativeId;
  const agent = f.store.getAssistant(f.id).runtimeAgentId;
  const runSession = `agent:${agent}:cron:${jobId}:run:run-1`;
  const reads = gateway(f, runSession, `Something else entirely. ${digest}`);
  const complete = (runAtMs, extra) =>
    f.reminders.complete(routine.id, {
      jobId,
      runAtMs,
      status: "ok",
      summary: capped(digest),
      deliveryStatus: "delivered",
      ...extra,
    });
  // Another job's or agent's session is never read.
  await complete(1000, { sessionKey: `agent:${agent}:cron:other:run:run-1` });
  await complete(2000, { sessionKey: `agent:someone:cron:${jobId}:run:run-1` });
  await complete(3000, {});
  assert.equal(reads.length, 0);
  // A reply that does not begin with the summary is not this run's result.
  await complete(4000, { sessionKey: runSession });
  assert.equal(reads.length, 1);
  // A later run of the job has replaced the transcript.
  reads.state.sessionId = "run-2";
  await complete(4500, { sessionKey: runSession });
  assert.equal(reads.length, 2);
  reads.state.sessionId = "run-1";
  // The Gateway being away keeps the summary as well.
  f.setReady(false);
  await complete(5000, { sessionKey: runSession });
  assert.equal(reads.length, 2);
  f.setReady(true);
  for (const entry of f.service.outbox.all(f.channel.id))
    assert.equal(entry.text, capped(digest));
  // A short summary is complete: no history read at all.
  await complete(6000, { summary: "Short.", sessionKey: runSession });
  assert.equal(reads.length, 2);
});

test("a replayed completion keeps the full text it was first delivered with", async (t) => {
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, f.input);
  const jobId = f.reminders.bindings.get(routine.id).nativeId;
  const agent = f.store.getAssistant(f.id).runtimeAgentId;
  const runSession = `agent:${agent}:cron:${jobId}:run:run-1`;
  gateway(f, runSession);
  const event = {
    jobId,
    runAtMs: 1000,
    status: "ok",
    summary: capped(digest),
    deliveryStatus: "delivered",
    sessionKey: runSession,
  };
  await f.reminders.complete(routine.id, event);
  // The run session is gone by the time OpenClaw retries the webhook.
  f.setReady(false);
  await f.reminders.complete(routine.id, event);
  const entries = f.service.outbox.all(f.channel.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, digest);
});

test("a routine paused while its full result is read sends nothing", async (t) => {
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, f.input);
  const jobId = f.reminders.bindings.get(routine.id).nativeId;
  const agent = f.store.getAssistant(f.id).runtimeAgentId;
  const runSession = `agent:${agent}:cron:${jobId}:run:run-1`;
  const reads = gateway(f, runSession);
  reads.during = () =>
    f.routines.update(f.id, routine.id, { enabled: false, revision: 1 });
  await f.reminders.complete(routine.id, {
    jobId,
    runAtMs: 1000,
    status: "ok",
    summary: capped(digest),
    deliveryStatus: "delivered",
    sessionKey: runSession,
  });
  assert.equal(reads.length, 1);
  assert.deepEqual(f.service.outbox.all(f.channel.id), []);
  assert.deepEqual(f.routines.results.forConversation(f.channel.conversationId), []);
});

test("a long check-in reaches Telegram in full", async (t) => {
  const f = routineFixture(t);
  f.store.updateAssistant(
    f.id,
    {
      capabilities: { memory: true, reminders: true },
      heartbeat: { enabled: true, interval: "4h", start: 8, end: 20, timeZone: "UTC" },
    },
    f.store.getAssistant(f.id).revision,
  );
  const heartbeats = new NativeHeartbeats({
    reminders: f.reminders,
    notifications: { notify: async () => {} },
  });
  await heartbeats.sync(f.id);
  const binding = f.reminders.bindings.list(f.id).find((b) => b.kind === "heartbeat");
  const agent = f.store.getAssistant(f.id).runtimeAgentId;
  const runSession = `agent:${agent}:cron:${binding.nativeId}:run:run-9`;
  gateway(f, runSession);
  await f.reminders.complete(binding.id, {
    jobId: binding.nativeId,
    runAtMs: 1000,
    status: "ok",
    summary: capped(digest),
    deliveryStatus: "delivered",
    sessionKey: runSession,
  });
  const [entry] = f.service.outbox.all(f.channel.id);
  assert.ok(entry.text.endsWith(digest));
  assert.ok(entry.parts.length > 1);
});

test("an ordinary reply longer than OpenClaw's history default reaches Telegram in full", async (t) => {
  const f = routineFixture(t);
  const reply = `${digest}\n\n${digest}`;
  assert.ok(reply.length > 8000);
  const reads = [];
  let runId;
  const service = {
    store: f.store,
    ledger: f.assistants.ledger,
    runtime: {
      generation: 1,
      client: {
        ready: true,
        // OpenClaw's chat.history: each text cut at maxChars, 8000 by default.
        call: async (method, input) => {
          assert.equal(method, "chat.history");
          reads.push(input);
          const max = input.maxChars ?? 8000;
          return {
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text:
                      reply.length > max
                        ? `${reply.slice(0, max)}\n...(truncated)...`
                        : reply,
                  },
                ],
                timestamp: 2000,
                __openclaw: { id: "m1", runId },
              },
            ],
          };
        },
      },
    },
  };
  f.assistants.history = (id) => conversationHistory(service, id);
  const sends = telegram(f);
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  await f.service.ingress.dispatch(f.channel.id);
  const entry = f.service.ledger.list(f.channel.id)[0];
  runId = entry.attemptId;
  f.assistants.ledger.transition(entry.attemptId, "completed");
  await f.service.delivery.process(f.channel.id, new AbortController().signal);
  await f.service.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(reads[0].maxChars, 65536);
  assert.ok(sends.length > 2);
  const joined = sends.map((s) => s.text).join("\n\n");
  assert.doesNotMatch(joined, /truncated/);
  assert.equal(joined.match(/<a href=/g).length, 36, "every link of both digests");
});
