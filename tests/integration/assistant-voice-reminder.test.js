import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { SpeechService } from "../../server/features/speech/speech-service.js";
import { DeepgramTranscriber } from "../../server/features/speech/deepgram-transcriber.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";

const signal = () => new AbortController().signal;

test("a spoken reminder request creates the reminder and confirms it in Telegram", async (t) => {
  const f = channelFixture(t);
  const id = f.channel.assistantId;
  f.store.updateAssistant(id, { capabilities: { memory: false, reminders: true } }, 1);
  f.assistants.admit = (fn) => fn();
  f.assistants.requireReady = () => {};
  f.assistants.config = { apply: async () => {} };
  const jobs = new Map();
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.list") return { jobs: [...jobs.values()], hasMore: false };
    if (method === "cron.add") {
      const job = { ...input, id: `job-${jobs.size}`, updatedAtMs: 1, state: {} };
      jobs.set(job.id, job);
      return { created: true, job };
    }
    assert.fail(method);
  };
  // The tool context recorded for each model turn, as the runtime does.
  const contexts = new Map();
  f.assistants.teams = { store: { context: (rid) => contexts.get(rid), list: () => [] } };
  const send = f.assistants.send;
  f.assistants.send = async (cid, input, context) => {
    const sent = await send(cid, input);
    contexts.set(sent.request.id, context);
    return sent;
  };
  const reminders = new NativeReminders({
    assistants: f.assistants,
    channels: f.service,
    dataDir: f.dataDir,
  });
  f.assistants.reminders = reminders;
  t.after(() => reminders.close());
  f.speech.save({ apiKey: "synthetic-deepgram", revision: 0, language: "en" });
  f.client.audio = async () => Buffer.from("synthetic audio");
  f.service.speechService = new SpeechService({
    connections: f.speech,
    transcriber: new DeepgramTranscriber({
      fetchImpl: async () =>
        Response.json({
          results: {
            channels: [{ alternatives: [{ transcript: "Remind me tomorrow at 9." }] }],
          },
        }),
    }),
  });
  const delivered = [];
  f.client.call = async (method, params) => {
    assert.equal(method, "sendMessage");
    delivered.push(params);
    return { message_id: delivered.length, chat: { id: 42 } };
  };
  const update = telegramMessage(1);
  delete update.message.text;
  update.message.voice = {
    file_id: "v",
    mime_type: "audio/ogg",
    file_size: 15,
    duration: 3,
  };
  await f.service.ingress.receive(f.channel.id, [update]);
  await f.service.process(f.channel.id, signal());
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, "Remind me tomorrow at 9.");
  const [entry] = f.service.ledger.list(f.channel.id);
  assert.equal(contexts.get(entry.requestId).kind, "telegram");

  // The fake model answers the transcribed turn with a reminder tool call.
  const tomorrow = new Date(Date.now() + 86400000);
  tomorrow.setUTCHours(9, 0, 0, 0);
  const reminder = await reminders.invoke(
    { attemptId: entry.attemptId, toolCallId: "call-1", assertCurrent() {} },
    {
      action: "create",
      name: "Morning",
      message: "It is 9 o'clock.",
      schedule: { kind: "at", at: tomorrow.toISOString() },
    },
  );
  assert.equal(reminder.status, "ready");
  const [binding] = reminders.bindings.list(id);
  assert.equal(binding.source.chatId, "42");
  assert.equal(binding.source.channelId, f.channel.id);
  assert.equal(jobs.size, 1);
  f.assistants.ledger.transition(entry.attemptId, "completed");
  f.assistants.history = async () => ({
    stale: false,
    messages: [
      {
        role: "assistant",
        runId: entry.attemptId,
        text: "Done. I will remind you tomorrow at 9.",
      },
    ],
  });
  await f.service.process(f.channel.id, signal());
  assert.equal(f.service.ledger.get(entry.id).state, "delivered");
  assert.deepEqual(
    delivered.map((d) => d.text),
    ["Done. I will remind you tomorrow at 9."],
  );
});
