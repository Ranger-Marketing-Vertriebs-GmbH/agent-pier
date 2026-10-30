import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { signedInUser } from "../helpers/users.js";

// Talk mode (AGENTPIER-291) end to end behind the HTTP and WebSocket boundaries, with
// stand-ins for Deepgram, the Gateway and the voice provider: no real service is called.

const deepgramKey = "dg-talk-fixture-key";
// Synthetic, assembled at runtime: no key-shaped literal in the source.
const voiceKey = ["sk", "voice", "fixture", "x".repeat(16)].join("-");
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0, 0, 0, 0]);

// Deepgram's live endpoint: the first audio is answered with the final words of an
// utterance (speech_final) and the utterance end.
async function fakeDeepgram(t, words) {
  const calls = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => {
      calls.push(new URL(req.url, "http://x"));
      let answered = false;
      ws.on("message", (_data, binary) => {
        if (!binary || answered) return;
        answered = true;
        ws.send(
          JSON.stringify({
            type: "Results",
            is_final: true,
            speech_final: true,
            channel: { alternatives: [{ transcript: words }] },
          }),
        );
        ws.send(JSON.stringify({ type: "UtteranceEnd", last_word_end: 1.2 }));
      });
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => server.close(r));
  });
  const port = server.address().port;
  return {
    calls,
    connect: (url, headers) =>
      new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`, { headers }),
  };
}

// The voice provider: records each request and answers with a few MP3 bytes.
function fakeVoice() {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
    },
  };
}

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

async function setup(t, { voice = true } = {}) {
  const deepgram = await fakeDeepgram(t, "Wie wird das Wetter morgen?");
  const provider = fakeVoice();
  const { f, gateway } = await chatFixture(t, {
    dictationConnect: deepgram.connect,
    speechFetch: provider.fetch,
  });
  await json(
    await f.request("/api/assistant-speech", {
      method: "PUT",
      body: { apiKey: deepgramKey, revision: 0, language: "de" },
    }),
    200,
  );
  if (voice) {
    const saved = await json(
      await f.request("/api/assistant-speech/voice", {
        method: "PUT",
        body: { revision: 0, openaiApiKey: voiceKey, openaiVoice: "nova" },
      }),
      200,
    );
    assert.equal(saved.hasOpenaiKey, true);
    assert.equal(JSON.stringify(saved).includes(voiceKey), false);
  }
  const agent = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Helper", instructions: "", model: fixtureModel(f) },
    }),
    201,
  );
  const chat = await json(
    await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" }),
    200,
  );
  const open = (talk, cookie = f.cookie) => {
    const ws = new WebSocket(
      `${f.url.replace("http:", "ws:")}/api/dictation/stream?talk=${talk}`,
      { origin: f.url, headers: { cookie } },
    );
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    const closed = new Promise((resolve) => ws.on("close", resolve));
    return { ws, messages, closed };
  };
  return { f, gateway, deepgram, provider, agent, chat, open };
}

const until = async (check) => {
  for (let n = 0; n < 300 && !check(); n++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check());
};
const pcm = () => Buffer.alloc(3200, 1);

test("a spoken turn becomes a chat turn, its reply is read aloud, then it listens again", async (t) => {
  const { f, gateway, deepgram, provider, chat, open } = await setup(t);
  const status = await json(await f.request("/api/assistant-talk"), 200);
  assert.deepEqual(status, {
    available: true,
    provider: "openai",
    maxMinutes: 30,
    session: null,
  });
  const session = await json(
    await f.request("/api/assistant-talk", {
      method: "POST",
      body: { conversationId: chat.id },
    }),
    201,
  );
  assert.equal(session.expiresAt - session.startedAt, 30 * 60 * 1000);

  // Listening: Deepgram marks the end of the utterance.
  const turn = open(session.id);
  await new Promise((r) => turn.ws.on("open", r));
  turn.ws.send(pcm());
  await until(() => turn.messages.some((m) => m.type === "utteranceEnd"));
  assert.deepEqual(
    turn.messages.find((m) => m.type === "transcript"),
    {
      type: "transcript",
      final: true,
      text: "Wie wird das Wetter morgen?",
      speechFinal: true,
    },
  );
  assert.equal(deepgram.calls[0].searchParams.get("utterance_end_ms"), "1500");
  turn.ws.close();
  await turn.closed;

  // Thinking: the words go out as a normal chat turn.
  await json(
    await f.request(`/api/assistant-conversations/${chat.id}/messages`, {
      method: "POST",
      body: { clientRequestId: crypto.randomUUID(), text: "Wie wird das Wetter morgen?" },
    }),
    202,
  );
  const sent = gateway.sent.at(-1);
  assert.match(sent.message, /Wie wird das Wetter morgen\?/);
  gateway.history[sent.key] = [
    {
      role: "user",
      content: "Wie wird das Wetter morgen?",
      timestamp: 1,
      __openclaw: { id: "turn-1" },
    },
    {
      role: "assistant",
      content:
        'Sonnig. Details:\n```json\n{"temp": 21}\n```\nMehr unter https://wetter.example.com/berlin/morgen/stuendlich',
      timestamp: 2,
      __openclaw: { id: "reply-1" },
    },
  ];

  // Speaking: the reply is read by message id, never from text the browser sends.
  const audio = await f.request(
    `/api/assistant-conversations/${chat.id}/messages/reply-1/speech`,
    { method: "POST", body: { language: "de" } },
  );
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), mp3);
  const [call] = provider.calls;
  assert.equal(call.url, "https://api.openai.com/v1/audio/speech");
  assert.equal(call.headers.Authorization, `Bearer ${voiceKey}`);
  assert.equal(call.body.voice, "nova");
  assert.equal(
    call.body.input,
    "Sonnig. Details:\n(siehe Bildschirm)\nMehr unter (siehe Bildschirm)",
  );
  // The user's own words are not read through this route.
  await json(
    await f.request(`/api/assistant-conversations/${chat.id}/messages/turn-1/speech`, {
      method: "POST",
      body: { language: "de" },
    }),
    404,
  );
  await json(
    await f.request(`/api/assistant-conversations/${chat.id}/messages/reply-1/speech`, {
      method: "POST",
      body: { text: "Read this instead" },
    }),
    400,
  );

  // Listening again: the next turn of the same session opens.
  const next = open(session.id);
  await until(() => next.messages.some((m) => m.type === "ready"));
  // Stop ends the session and the dictation it holds.
  assert.deepEqual(
    await json(
      await f.request("/api/assistant-talk", {
        method: "DELETE",
        body: { id: session.id },
      }),
      200,
    ),
    { stopped: true },
  );
  await next.closed;
  assert.deepEqual(next.messages.at(-1), { type: "ended", reason: "talkEnded" });
  const after = open(session.id);
  await after.closed;
  assert.deepEqual(after.messages, [{ type: "error", code: "talkEnded" }]);
  const audit = f.application.audit
    .list({ limit: 50 })
    .events.filter((e) => e.action === "speech.completed");
  assert.ok(audit.some((e) => e.details.kind === "talk"));
  assert.ok(audit.some((e) => e.details.kind === "speech-output"));
  assert.equal(JSON.stringify(audit).includes("Sonnig"), false);
});

test("a talk session ends at its length cap", async (t) => {
  const { f, chat, open } = await setup(t);
  f.application.talk.limits.maxMs = 300;
  const session = await json(
    await f.request("/api/assistant-talk", {
      method: "POST",
      body: { conversationId: chat.id },
    }),
    201,
  );
  const turn = open(session.id);
  await until(() => turn.messages.some((m) => m.type === "ready"));
  await turn.closed;
  assert.deepEqual(turn.messages.at(-1), { type: "ended", reason: "talkEnded" });
  const status = await json(await f.request("/api/assistant-talk"), 200);
  assert.equal(status.session, null);
});

test("without a voice the Talk button says why and no session starts", async (t) => {
  const { f, chat } = await setup(t, { voice: false });
  const status = await json(await f.request("/api/assistant-talk"), 200);
  assert.equal(status.available, false);
  assert.equal(status.reason, "voiceMissing");
  const refused = await json(
    await f.request("/api/assistant-talk", {
      method: "POST",
      body: { conversationId: chat.id },
    }),
    409,
  );
  assert.deepEqual(refused, { code: "voiceMissing" });
});

test("talk mode is the owner's: users and users' chats are refused", async (t) => {
  const { f, open } = await setup(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const request = as(f, cookie);
  assert.equal((await request("/api/assistant-talk")).status, 404);
  assert.equal((await request("/api/assistant-speech/voice")).status, 404);
  // Her dictation cannot be a talk turn.
  const hers = open("some-talk-session-id", cookie);
  await hers.closed;
  assert.deepEqual(hers.messages, [{ type: "error", code: "talkUnavailable" }]);
  // The owner cannot talk in, or have read aloud, a user's chat.
  const agent = await userAgent(f, {
    mode: "shared",
    members: [{ userId: user.id, level: "chat" }],
  });
  const herChat = await f.application.assistants.openConversation(agent.id, {
    userId: user.id,
  });
  await json(
    await f.request("/api/assistant-talk", {
      method: "POST",
      body: { conversationId: herChat.id },
    }),
    404,
  );
  assert.equal(
    (
      await f.request(`/api/assistant-conversations/${herChat.id}/messages/x/speech`, {
        method: "POST",
        body: { language: "en" },
      })
    ).status,
    404,
  );
});
