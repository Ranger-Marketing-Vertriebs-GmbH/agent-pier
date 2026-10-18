import test from "node:test";
import assert from "node:assert/strict";
import {
  deepgramLiveUrl,
  liveFailure,
  parseLiveMessage,
} from "../../server/features/speech/deepgram-live.js";

test("the live URL streams 16 kHz PCM with interim results in the stored model", () => {
  const url = deepgramLiveUrl({ model: "nova-3", language: "de", apiKey: "dg-secret" });
  assert.equal(url.origin + url.pathname, "wss://api.deepgram.com/v1/listen");
  const query = Object.fromEntries(url.searchParams);
  assert.equal(query.model, "nova-3");
  assert.equal(query.language, "de");
  assert.equal(query.encoding, "linear16");
  assert.equal(query.sample_rate, "16000");
  assert.equal(query.channels, "1");
  assert.equal(query.interim_results, "true");
  assert.equal(query.smart_format, "true");
  assert.deepEqual(url.searchParams.getAll("keyterm"), ["AgentPier"]);
  // The key never travels in the address; it goes in the Authorization header.
  assert.equal(url.href.includes("dg-secret"), false);
});

test("automatic language streams as multi on Nova-3 and falls back elsewhere", () => {
  assert.equal(
    deepgramLiveUrl({ model: "nova-3", language: "auto" }).searchParams.get("language"),
    "multi",
  );
  const older = deepgramLiveUrl({ model: "nova-2", language: "auto" });
  assert.equal(older.searchParams.get("language"), null);
  assert.deepEqual(older.searchParams.getAll("keywords"), ["AgentPier:2"]);
  assert.equal(
    deepgramLiveUrl({ model: "nova-2", language: "en-US" }).searchParams.get("language"),
    "en-US",
  );
  const local = deepgramLiveUrl(
    { model: "nova-3", language: "en" },
    "ws://127.0.0.1:9/v1/listen",
  );
  assert.equal(local.host, "127.0.0.1:9");
});

test("results become interim or final transcripts; everything else is ignored", () => {
  const result = (transcript, isFinal) =>
    JSON.stringify({
      type: "Results",
      is_final: isFinal,
      channel: { alternatives: [{ transcript }] },
    });
  assert.deepEqual(parseLiveMessage(result("hallo", false)), {
    type: "transcript",
    final: false,
    text: "hallo",
  });
  assert.deepEqual(parseLiveMessage(result(" hallo welt ", true)), {
    type: "transcript",
    final: true,
    text: "hallo welt",
  });
  // An empty final still ends the segment: the interim text it replaced is gone.
  assert.deepEqual(parseLiveMessage(result("", true)), {
    type: "transcript",
    final: true,
    text: "",
  });
  assert.equal(parseLiveMessage(result("", false)), null);
  for (const other of [
    JSON.stringify({ type: "Metadata", duration: 3 }),
    JSON.stringify({ type: "SpeechStarted" }),
    "not json",
    JSON.stringify({ type: "Results", channel: { alternatives: [{ transcript: 4 }] } }),
    JSON.stringify({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "x".repeat(20001) }] },
    }),
  ])
    assert.equal(parseLiveMessage(other), null);
  // Control characters never reach the composer.
  assert.equal(parseLiveMessage(result("a\u0000b\u001bc", true)).text, "a b c");
});

test("upstream refusals map to stable codes without upstream text", () => {
  assert.equal(liveFailure({ status: 401 }), "auth");
  assert.equal(liveFailure({ status: 403 }), "auth");
  assert.equal(liveFailure({ status: 402 }), "quota");
  assert.equal(liveFailure({ status: 429 }), "upstreamBusy");
  assert.equal(liveFailure({ status: 400 }), "rejected");
  assert.equal(liveFailure({ status: 500 }), "failed");
  assert.equal(liveFailure({}), "failed");
});
