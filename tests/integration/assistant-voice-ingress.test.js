import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { SpeechService } from "../../server/features/speech/speech-service.js";
import { DeepgramTranscriber } from "../../server/features/speech/deepgram-transcriber.js";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";
const voiceUpdate = () => {
  const u = telegramMessage(1);
  delete u.message.text;
  u.message.voice = {
    file_id: "voice-id",
    mime_type: "audio/ogg",
    file_size: 10,
    duration: 2,
  };
  return u;
};
test("Telegram voice is transcribed with central settings and dispatched once as inspectable text", async (t) => {
  const f = channelFixture(t);
  f.speech.save({ apiKey: "private-deepgram", revision: 0, language: "de" });
  let transcriptions = 0;
  const transcriber = new DeepgramTranscriber({
    fetchImpl: async (url, options) => {
      transcriptions++;
      assert.equal(new URL(url).searchParams.get("language"), "de");
      assert.equal(options.headers.Authorization, "Token private-deepgram");
      assert.equal(options.headers["Content-Type"], "audio/ogg");
      return Response.json({
        results: {
          channels: [{ alternatives: [{ transcript: " Plane unser Abendessen. " }] }],
        },
        metadata: { duration: 2 },
      });
    },
  });
  f.client.audio = async () => Buffer.from("audio");
  f.service.speechService = new SpeechService({ connections: f.speech, transcriber });
  await f.service.ingress.receive(f.channel.id, [voiceUpdate(), voiceUpdate()]);
  await f.service.process(f.channel.id, new AbortController().signal);
  assert.equal(transcriptions, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, "Plane unser Abendessen.");
  assert.equal(f.service.ledger.public(f.channel.id)[0].text, "Plane unser Abendessen.");
});
test("oversized, unsupported and missing-key voice never reaches Deepgram or the model", async (t) => {
  const f = channelFixture(t);
  const speech = new SpeechService({
    connections: f.speech,
    transcriber: { transcribe: () => assert.fail("must not transcribe") },
  });
  const client = { audio: () => assert.fail("must not download") };
  for (const voice of [
    { fileId: "v", size: 11 * 1024 * 1024, mime: "audio/ogg" },
    { fileId: "v", size: 10, mime: "text/plain" },
    { fileId: "v", size: 10, mime: "audio/ogg" },
  ])
    await assert.rejects(speech.transcribe({ voice, client }), (e) =>
      ["MEDIA_TOO_LARGE", "MEDIA_UNSUPPORTED", "SPEECH_NOT_CONFIGURED"].includes(e.code),
    );
});
test("download is bounded by actual bytes and upstream failures never leak credentials", async () => {
  const client = new TelegramClient({
    token: "123456:abcdefghijklmnopqrstuv",
    fetchImpl: async (url) =>
      url.endsWith("getFile")
        ? Response.json({ ok: true, result: { file_path: "voice/file.oga" } })
        : new Response(new Uint8Array(11)),
  });
  await assert.rejects(client.audio("file", undefined, 10), { code: "MEDIA_TOO_LARGE" });
  const transcriber = new DeepgramTranscriber({
    fetchImpl: async () => {
      throw Error("private-secret raw-url");
    },
  });
  await assert.rejects(
    transcriber.transcribe({
      audio: Buffer.from("audio"),
      apiKey: "private-secret",
      model: "nova-3",
      language: "auto",
    }),
    (e) => e.code === "TRANSCRIPTION_FAILED" && !String(e).includes("private-secret"),
  );
});
test("an interrupted transcription stays visible and does not dispatch or repeat automatically", async (t) => {
  const f = channelFixture(t);
  f.speech.save({ apiKey: "private-deepgram", revision: 0 });
  f.client.audio = async () => Buffer.from("audio");
  f.service.speechService = new SpeechService({
    connections: f.speech,
    transcriber: {
      transcribe: async () => {
        throw Error("lost response");
      },
    },
  });
  await f.service.ingress.receive(f.channel.id, [voiceUpdate()]);
  await f.service.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.ledger.list(f.channel.id)[0].state, "transcription_failed");
  await f.service.process(f.channel.id, new AbortController().signal);
  assert.equal(f.sent.length, 0);
});
test("Deepgram rejections, quota and rate limits become distinct bounded diagnostics", async (t) => {
  const secret = "private-deepgram";
  const body = `{"err_msg":"bad audio ${secret}\u0007 ${"x".repeat(400)}"}`;
  for (const [status, code] of [
    [400, "TRANSCRIPTION_REJECTED"],
    [402, "TRANSCRIPTION_QUOTA"],
  ]) {
    let calls = 0;
    const transcriber = new DeepgramTranscriber({
      fetchImpl: async () => {
        calls++;
        return new Response(body, { status });
      },
      sleep: () => assert.fail("must not retry"),
    });
    await assert.rejects(
      transcriber.transcribe({
        audio: Buffer.from("audio"),
        apiKey: secret,
        model: "nova-3",
        language: "en",
      }),
      (e) => {
        assert.equal(e.code, code);
        assert.ok(e.detail.length <= 200);
        assert.ok(e.detail.startsWith('{"err_msg":"bad audio'));
        assert.ok(!e.detail.includes(secret));
        assert.ok(!/[\u0000-\u001f]/.test(e.detail));
        return true;
      },
    );
    assert.equal(calls, 1);
  }
  const waits = [];
  let calls = 0;
  const limited = new DeepgramTranscriber({
    fetchImpl: async () => {
      calls++;
      return new Response("slow down", { status: 429 });
    },
    sleep: async (ms) => waits.push(ms),
  });
  await assert.rejects(
    limited.transcribe({
      audio: Buffer.from("a"),
      apiKey: secret,
      model: "nova-3",
      language: "en",
    }),
    { code: "TRANSCRIPTION_RATE_LIMITED", detail: "slow down" },
  );
  assert.equal(calls, 4);
  assert.equal(waits.length, 3);
  assert.ok(waits[0] < waits[1] && waits[1] < waits[2]);
  calls = 0;
  const recovering = new DeepgramTranscriber({
    fetchImpl: async () =>
      ++calls < 3
        ? new Response("", { status: 429, headers: { "retry-after": "2" } })
        : Response.json({
            results: { channels: [{ alternatives: [{ transcript: "Hi" }] }] },
          }),
    sleep: async (ms) => waits.push(ms),
  });
  const result = await recovering.transcribe({
    audio: Buffer.from("a"),
    apiKey: secret,
    model: "nova-3",
    language: "en",
  });
  assert.equal(result.text, "Hi");
  assert.equal(waits.at(-1), 2000);

  const f = channelFixture(t);
  f.speech.save({ apiKey: secret, revision: 0 });
  f.client.audio = async () => Buffer.from("audio");
  f.service.speechService = new SpeechService({
    connections: f.speech,
    transcriber: new DeepgramTranscriber({
      fetchImpl: async () => new Response(body, { status: 402 }),
    }),
  });
  await f.service.ingress.receive(f.channel.id, [voiceUpdate()]);
  await f.service.process(f.channel.id, new AbortController().signal);
  const [entry] = f.service.ledger.public(f.channel.id);
  assert.equal(entry.state, "transcription_failed");
  assert.equal(entry.diagnostic, "TRANSCRIPTION_QUOTA");
  assert.ok(entry.diagnosticDetail.length <= 200);
  assert.ok(!JSON.stringify(f.service.ledger.list(f.channel.id)).includes(secret));
  assert.ok(
    !JSON.stringify(f.service.ledger.list(f.channel.id)).includes("x".repeat(300)),
  );
});

test("an aborted transcription stops before waiting out a rate limit", async () => {
  const controller = new AbortController();
  const transcriber = new DeepgramTranscriber({
    fetchImpl: async () => {
      controller.abort();
      return new Response("", { status: 429, headers: { "retry-after": "30" } });
    },
  });
  const started = Date.now();
  await assert.rejects(
    transcriber.transcribe({
      audio: Buffer.from("a"),
      apiKey: "k",
      model: "nova-3",
      language: "en",
      signal: controller.signal,
    }),
    { code: "TRANSCRIPTION_INTERRUPTED" },
  );
  assert.ok(Date.now() - started < 1000);
});
