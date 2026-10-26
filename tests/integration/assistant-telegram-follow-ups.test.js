import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import {
  TelegramFollowUps,
  followUpGraceMs,
} from "../../server/features/assistant-channels/telegram-follow-ups.js";

const signal = () => new AbortController().signal;
const exec = { kind: "internal_system", sourceTool: "exec" };
const end = (runId, sessionKey = "session") => ({
  runId,
  sessionKey,
  stream: "lifecycle",
  data: { phase: "end" },
});

// A paired owner chat whose session holds a Telegram turn, then OpenClaw's own
// completion run `follow-1` (its transcript entry has the exec provenance).
function setup(t) {
  const f = channelFixture(t, { language: () => "en" });
  const contexts = new Map();
  const send = f.assistants.send;
  f.assistants.send = async (id, input, context = { kind: "owner" }) => {
    const sent = await send(id, input, context);
    contexts.set(sent.request.id, context);
    return sent;
  };
  f.assistants.teams = {
    store: { context: (id) => contexts.get(id) || { kind: "owner" }, list: () => [] },
  };
  const transcript = [];
  const history = [];
  f.assistants.runtime.client = {
    ready: true,
    async call(method, params) {
      assert.equal(method, "sessions.get");
      assert.equal(params.key, "session");
      return { messages: transcript };
    },
  };
  f.assistants.history = async () => ({ stale: false, messages: history });
  const telegram = [];
  f.client.call = async (method, input) => {
    telegram.push({ method, input });
    return method === "sendMessage"
      ? { message_id: telegram.length, chat: { id: 42 } }
      : true;
  };
  let n = 0;
  return {
    ...f,
    transcript,
    history,
    texts: () =>
      telegram.filter((c) => c.method === "sendMessage").map((c) => c.input.text),
    async turn(text = "Log in again", reply = "Starting the login.") {
      await f.service.ingress.receive(f.channel.id, [telegramMessage(++n, text)]);
      await f.service.ingress.dispatch(f.channel.id);
      const entry = f.service.ledger.list(f.channel.id).at(-1);
      f.assistants.ledger.transition(entry.attemptId, "completed");
      transcript.push(
        { role: "user", content: text, __openclaw: { runId: entry.attemptId } },
        { role: "assistant", content: reply, __openclaw: { runId: entry.attemptId } },
      );
      history.push({ role: "assistant", runId: entry.attemptId, text: reply });
      return entry;
    },
    followUp(runId, text, provenance = exec) {
      transcript.push(
        { role: "user", content: "Exec completed (abc12345, 0)", provenance },
        { role: "assistant", content: text, __openclaw: { runId } },
      );
      if (text !== null) history.push({ role: "assistant", runId, text });
    },
    async work() {
      await f.service.process(f.channel.id, signal());
      await f.service.process(f.channel.id, signal());
    },
  };
}

test("a follow-up run's reply after a Telegram turn reaches the paired chat once", async (t) => {
  const f = setup(t);
  await f.turn();
  f.followUp("follow-1", "The login timed out; please confirm it on the device.");
  f.service.followUps.observe(end("follow-1"));
  await f.work();

  assert.deepEqual(f.texts(), [
    "Starting the login.",
    "The login timed out; please confirm it on the device.",
  ]);
  const notice = f.service.outbox
    .all(f.channel.id)
    .find((e) => e.kind === "follow-up-reply");
  assert.equal(notice.state, "delivered");
  assert.equal(notice.chatId, "42");

  // A repeated end event, more passes and a restart send nothing again.
  f.service.followUps.observe(end("follow-1"));
  f.service.followUps = new TelegramFollowUps(f.service);
  f.service.followUps.observe(end("follow-1"));
  await f.work();
  assert.equal(f.texts().length, 2);
});

test("a follow-up run after a web turn or with the chat disabled stays in the web", async (t) => {
  const f = setup(t);
  await f.turn();
  await f.work();
  // The owner's latest turn came from the web.
  const web = await f.assistants.send(f.channel.conversationId, {
    clientRequestId: "web",
    text: "From the web",
  });
  f.assistants.ledger.transition(web.attempt.id, "completed");
  f.followUp("follow-1", "Done.");
  f.service.followUps.observe(end("follow-1"));
  await f.work();
  assert.deepEqual(f.service.followUps.all(f.channel.id), []);

  // A Telegram turn again, but the chat is switched off before the run ends.
  await f.turn("Again", "On it.");
  await f.work();
  const channel = f.service.store.get(f.channel.id);
  f.service.store.write({ ...channel, enabled: false }, channel.revision);
  f.followUp("follow-2", "Done again.");
  f.service.followUps.observe(end("follow-2"));
  assert.deepEqual(f.service.followUps.all(f.channel.id), []);
  assert.deepEqual(f.texts(), ["Starting the login.", "On it."]);
});

test("a recorded follow-up is dropped once its chat was paired anew", async (t) => {
  const f = setup(t);
  await f.turn();
  await f.work();
  f.followUp("follow-1", "Done.");
  f.service.followUps.observe(end("follow-1"));
  const channel = f.service.store.get(f.channel.id);
  f.service.store.write({ ...channel, chatId: "43", userId: "43" }, channel.revision);
  await f.service.followUps.process(f.channel.id, signal());
  const [row] = f.service.followUps.all(f.channel.id);
  assert.equal(row.state, "dropped");
  assert.equal(row.diagnostic, "CHANNEL_DESTINATION_CHANGED");
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
});

test("AgentPier turns, other sessions, other runs and silent replies are not sent", async (t) => {
  const f = setup(t);
  const entry = await f.turn();
  await f.work();
  // The Telegram turn's own run: delivered as its reply, never again.
  f.service.followUps.observe(end(entry.attemptId));
  // A routine's, hook's or check-in's run in a session of its own.
  f.service.followUps.observe(end("cron-run", "agent:home:cron:job:run:cron-run"));
  assert.deepEqual(f.service.followUps.all(f.channel.id), []);
  // A run in the chat's session that is no exec completion (a check-in turn).
  f.followUp("check-in", "Anything new?", {
    kind: "internal_system",
    sourceTool: "cron",
  });
  f.service.followUps.observe(end("check-in"));
  // A completion run that answers with OpenClaw's silent token.
  f.followUp("silent", "NO_REPLY");
  f.service.followUps.observe(end("silent"));
  await f.work();
  const rows = f.service.followUps.all(f.channel.id);
  assert.deepEqual(
    rows.map((r) => [r.runId, r.state, r.diagnostic]),
    [
      ["check-in", "dropped", "NOT_COMPLETION"],
      ["silent", "dropped", "SILENT_REPLY"],
    ],
  );
  assert.deepEqual(f.texts(), ["Starting the login."]);
});

test("a follow-up reply that trails the run's end is waited for", async (t) => {
  const f = setup(t);
  let now = 1000;
  f.service.now = () => now;
  await f.turn();
  await f.work();
  f.followUp("follow-1", null);
  f.service.followUps.observe(end("follow-1"));
  await f.work();
  assert.equal(f.service.followUps.all(f.channel.id)[0].state, "pending");
  now += followUpGraceMs / 2;
  f.history.push({ role: "assistant", runId: "follow-1", text: "Finished." });
  await f.work();
  assert.equal(f.service.followUps.all(f.channel.id)[0].state, "queued");
  assert.deepEqual(f.texts(), ["Starting the login.", "Finished."]);
});
