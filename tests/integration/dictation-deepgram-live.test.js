import test from "node:test";
import assert from "node:assert/strict";
import { DictationService } from "../../server/features/speech/dictation-service.js";

// Opt-in contract with the real Deepgram live endpoint. It runs only with a key of
// its own in AGENTPIER_DEEPGRAM_TEST_KEY and never reads a stored AgentPier key.
const apiKey = process.env.AGENTPIER_DEEPGRAM_TEST_KEY;

test(
  "Deepgram accepts AgentPier's live PCM stream and closes it after CloseStream",
  { skip: !apiKey && "set AGENTPIER_DEEPGRAM_TEST_KEY to run" },
  async () => {
    const settings = { model: "nova-3", language: "auto", hasSecret: true };
    const service = new DictationService({
      speech: () => ({
        get: () => settings,
        acquire: () => ({ ...settings, apiKey, release() {} }),
      }),
    });
    const messages = [];
    let closed;
    const done = new Promise((resolve) => (closed = resolve));
    const session = service.start({
      holder: "contract",
      client: { send: (message) => messages.push(message), close: closed },
    });
    for (let n = 0; n < 300 && !messages.length; n++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(messages[0]?.type, "ready", JSON.stringify(messages));
    // One second of a quiet 440 Hz tone, in 100 ms frames.
    for (let frame = 0; frame < 10; frame++) {
      const chunk = Buffer.alloc(3200);
      for (let i = 0; i < 1600; i++)
        chunk.writeInt16LE(
          Math.round(2000 * Math.sin((2 * Math.PI * 440 * (frame * 1600 + i)) / 16000)),
          i * 2,
        );
      session.audio(chunk);
      await new Promise((r) => setTimeout(r, 100));
    }
    session.stop();
    await done;
    assert.deepEqual(messages.at(-1), { type: "ended", reason: "stopped" });
  },
);
