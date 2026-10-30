import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpeechConnections } from "../../server/features/speech/speech-connections.js";
import {
  SpeechOutput,
  SpeechOutputError,
  speechFailure,
} from "../../server/features/speech/speech-output.js";

// Synthetic, assembled at runtime: no key-shaped literal in the source.
const openaiKey = ["sk", "openai", "fixture", "x".repeat(16)].join("-");
const elevenKey = ["el", "fixture", "x".repeat(16)].join("-");

async function connections(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-voice-"));
  const speech = new SpeechConnections({ dataDir });
  t.after(async () => {
    speech.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return speech;
}

test("voice keys are stored but never returned", async (t) => {
  const { voice } = await connections(t);
  assert.deepEqual(voice.get(), {
    revision: 0,
    provider: "openai",
    openaiVoice: "coral",
    elevenlabsVoice: "JBFqnCBsd6RMkjVDRZzb",
    hasOpenaiKey: false,
    hasElevenlabsKey: false,
  });
  assert.deepEqual(voice.status(), {
    available: false,
    provider: "openai",
    reason: "voiceMissing",
  });
  const saved = voice.save({ revision: 0, openaiApiKey: openaiKey, openaiVoice: "nova" });
  assert.equal(saved.hasOpenaiKey, true);
  assert.equal(JSON.stringify(saved).includes(openaiKey), false);
  assert.deepEqual(voice.status(), { available: true, provider: "openai" });
  assert.deepEqual(voice.acquire(), {
    provider: "openai",
    voice: "nova",
    apiKey: openaiKey,
  });
  // ElevenLabs chosen without its key: not usable, and the OpenAI key stays.
  const switched = voice.save({
    revision: 1,
    provider: "elevenlabs",
    elevenlabsApiKey: elevenKey,
  });
  assert.equal(JSON.stringify(switched).includes(elevenKey), false);
  assert.equal(voice.acquire().apiKey, elevenKey);
  voice.save({ revision: 2, removeElevenlabsApiKey: true });
  assert.equal(voice.acquire(), null);
  assert.equal(voice.status().reason, "voiceMissing");
  assert.equal(voice.get().hasOpenaiKey, true);
});

test("voice settings refuse unknown fields, bad values and stale revisions", async (t) => {
  const { voice } = await connections(t);
  for (const input of [
    { revision: 0, apiKey: "x" },
    { revision: 0, provider: "chatgpt" },
    { revision: 0, openaiVoice: "robot" },
    { revision: 0, elevenlabsVoice: "../voices" },
    { revision: 0, openaiApiKey: "with space" },
    { revision: 0, openaiApiKey: "k", removeOpenaiApiKey: true },
    null,
  ])
    assert.throws(() => voice.save(input), { status: 400 });
  assert.throws(() => voice.save({ revision: 5 }), { status: 409 });
  assert.equal(voice.get().revision, 0);
});

function fakeVoices(lease) {
  return {
    acquire: () => lease,
    status: () => ({ available: true, provider: lease.provider }),
  };
}
const audio = (bytes = [1, 2, 3]) =>
  new Response(new Uint8Array(bytes), { headers: { "content-type": "audio/mpeg" } });
async function read(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("OpenAI and ElevenLabs get the reply with the stored key and voice", async () => {
  const calls = [];
  const audits = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return audio();
  };
  const openai = new SpeechOutput({
    voices: () => fakeVoices({ provider: "openai", voice: "nova", apiKey: openaiKey }),
    fetchImpl,
    audit: { append: (event) => audits.push(event) },
  });
  const spoken = await openai.synthesize({ holder: "a", text: "Hallo." });
  assert.equal(spoken.mime, "audio/mpeg");
  assert.deepEqual([...(await read(spoken.stream))], [1, 2, 3]);
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${openaiKey}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "gpt-4o-mini-tts",
    voice: "nova",
    input: "Hallo.",
    response_format: "mp3",
  });
  assert.equal(calls[0].init.redirect, "error");
  const eleven = new SpeechOutput({
    voices: () =>
      fakeVoices({
        provider: "elevenlabs",
        voice: "JBFqnCBsd6RMkjVDRZzb",
        apiKey: elevenKey,
      }),
    fetchImpl,
  });
  await read((await eleven.synthesize({ holder: "a", text: "Hi." })).stream);
  const url = new URL(calls[1].url);
  assert.equal(url.pathname, "/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream");
  assert.equal(url.searchParams.get("output_format"), "mp3_44100_128");
  assert.equal(calls[1].init.headers["xi-api-key"], elevenKey);
  assert.equal(JSON.parse(calls[1].init.body).model_id, "eleven_multilingual_v2");
  // The audit names the use and its length, never the text or the key.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audits[0].details.kind, "speech-output");
  assert.equal(audits[0].details.count, 6);
  assert.equal(JSON.stringify(audits).includes("Hallo"), false);
});

test("upstream refusals become stable codes without upstream text or key", async () => {
  for (const [status, code] of [
    [401, "auth"],
    [402, "quota"],
    [429, "upstreamBusy"],
    [400, "rejected"],
    [500, "failed"],
  ]) {
    assert.equal(speechFailure(status), code);
    const output = new SpeechOutput({
      voices: () => fakeVoices({ provider: "openai", voice: "nova", apiKey: openaiKey }),
      fetchImpl: async () => new Response(`{"error":"bad key ${openaiKey}"}`, { status }),
    });
    await assert.rejects(output.synthesize({ holder: "a", text: "x" }), (error) => {
      assert.ok(error instanceof SpeechOutputError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes(openaiKey), false);
      return true;
    });
  }
  const missing = new SpeechOutput({ voices: () => ({ acquire: () => null }) });
  await assert.rejects(missing.synthesize({ holder: "a", text: "x" }), {
    code: "voiceMissing",
  });
  const off = new SpeechOutput({ voices: () => null });
  assert.deepEqual(off.status(), { available: false, reason: "agentsOff" });
});

test("one reading per login at a time and a start window", async () => {
  let now = 0;
  const output = new SpeechOutput({
    voices: () => fakeVoices({ provider: "openai", voice: "nova", apiKey: openaiKey }),
    fetchImpl: async () => audio(),
    clock: { now: () => now },
    limits: { starts: 2 },
  });
  const first = await output.synthesize({ holder: "a", text: "x" });
  await assert.rejects(output.synthesize({ holder: "a", text: "x" }), { code: "busy" });
  await read(first.stream);
  await new Promise((resolve) => setImmediate(resolve));
  await read((await output.synthesize({ holder: "a", text: "x" })).stream);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(output.synthesize({ holder: "a", text: "x" }), {
    code: "rateLimited",
  });
  now += 11 * 60 * 1000;
  await read((await output.synthesize({ holder: "a", text: "x" })).stream);
});

test("a reading longer than the byte cap ends", async () => {
  const output = new SpeechOutput({
    voices: () => fakeVoices({ provider: "openai", voice: "nova", apiKey: openaiKey }),
    fetchImpl: async () => audio(new Array(64).fill(1)),
    limits: { maxBytes: 10 },
  });
  const spoken = await output.synthesize({ holder: "a", text: "x" });
  await assert.rejects(read(spoken.stream), { code: "tooLong" });
});
