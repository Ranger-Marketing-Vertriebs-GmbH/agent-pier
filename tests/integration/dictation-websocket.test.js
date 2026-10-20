import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";

const key = "dg-fixture-key";

// A stand-in for Deepgram's live endpoint: it records the handshake and the audio,
// answers the first frame with an interim result and CloseStream with the final one.
async function fakeDeepgram(t, { status } = {}) {
  const calls = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const call = { url: new URL(req.url, "http://x"), headers: req.headers, bytes: 0 };
    calls.push(call);
    if (status) {
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      call.ws = ws;
      const result = (transcript, final) =>
        ws.send(
          JSON.stringify({
            type: "Results",
            is_final: final,
            channel: { alternatives: [{ transcript }] },
          }),
        );
      ws.on("message", (data, binary) => {
        if (binary) {
          if (!call.bytes) result("hallo", false);
          call.bytes += data.length;
          return;
        }
        if (JSON.parse(String(data)).type !== "CloseStream") return;
        result("Hallo Welt.", true);
        ws.send(JSON.stringify({ type: "Metadata", duration: 1 }));
        ws.close(1000);
      });
    });
  });
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

async function setup(t, deepgram, { configure = true } = {}) {
  const f = await applicationFixture(t, {
    ...enabledAssistants,
    dictationConnect: deepgram.connect,
  });
  if (configure) {
    const saved = await fixtureFetch(f.url + "/api/assistant-speech", {
      method: "PUT",
      headers: { origin: f.url, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: key, revision: 0, language: "de" }),
    });
    assert.equal(saved.status, 200);
  }
  const address = `${f.url.replace("http:", "ws:")}/api/dictation/stream`;
  const open = (options = { origin: f.url, headers: { cookie: f.cookie } }) => {
    const ws = new WebSocket(address, options);
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    const closed = new Promise((resolve) => ws.on("close", resolve));
    return { ws, messages, closed };
  };
  return { f, open };
}

const until = async (check) => {
  for (let n = 0; n < 300 && !check(); n++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check());
};
const pcm = (ms) => Buffer.alloc(32 * ms, 1);

test("dictation relays interim and final transcripts through the stored key", async (t) => {
  const deepgram = await fakeDeepgram(t);
  const { f, open } = await setup(t, deepgram);
  const status = await fixtureFetch(f.url + "/api/dictation");
  assert.deepEqual(await status.json(), { available: true, autoSend: false });
  const { ws, messages, closed } = open();
  await new Promise((r) => ws.on("open", r));
  // Audio sent before Deepgram accepted the stream is kept and forwarded in order.
  ws.send(pcm(100));
  await until(() => messages.some((m) => m.type === "ready"));
  ws.send(pcm(100));
  await until(() => messages.some((m) => m.type === "transcript"));
  ws.send(JSON.stringify({ type: "stop" }));
  await closed;
  assert.deepEqual(
    messages.filter((m) => m.type !== "ready"),
    [
      { type: "transcript", final: false, text: "hallo" },
      { type: "transcript", final: true, text: "Hallo Welt." },
      { type: "ended", reason: "stopped" },
    ],
  );
  const [call] = deepgram.calls;
  assert.equal(call.headers.authorization, `Token ${key}`);
  assert.equal(call.url.searchParams.get("language"), "de");
  assert.equal(call.url.searchParams.get("encoding"), "linear16");
  assert.equal(call.bytes, pcm(200).length);
  // The audit names the use and its length, never audio or text.
  const audit = await (
    await fixtureFetch(f.url + "/api/audit?action=speech.completed")
  ).json();
  const [event] = audit.events;
  assert.equal(event.outcome, "success");
  assert.equal(event.resourceType, "speech");
  assert.deepEqual(Object.keys(event.details).sort(), ["kind", "seconds"]);
  assert.equal(event.details.kind, "dictation");
  assert.doesNotMatch(JSON.stringify(audit), /Hallo|hallo|dg-fixture/);
  // The settings stay editable once the stream is open: no lease is left behind.
  const speech = await (await fixtureFetch(f.url + "/api/assistant-speech")).json();
  const saved = await fixtureFetch(f.url + "/api/assistant-speech", {
    method: "PUT",
    headers: { origin: f.url, "content-type": "application/json" },
    body: JSON.stringify({ revision: speech.revision, dictationSend: true }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).dictationSend, true);
  assert.deepEqual(await (await fixtureFetch(f.url + "/api/dictation")).json(), {
    available: true,
    autoSend: true,
  });
});

test("dictation refuses foreign origins and missing logins", async (t) => {
  const deepgram = await fakeDeepgram(t);
  const { f, open } = await setup(t, deepgram);
  for (const options of [
    { origin: f.url },
    { origin: "https://evil.example", headers: { cookie: f.cookie } },
  ]) {
    const { ws } = open(options);
    const result = await new Promise((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("open", () => resolve("open"));
      ws.on("error", () => {});
    });
    assert.notEqual(result, "open");
  }
  assert.equal(deepgram.calls.length, 0);
});

test("without a key, dictation reports it and never calls Deepgram", async (t) => {
  const deepgram = await fakeDeepgram(t);
  const { f, open } = await setup(t, deepgram, { configure: false });
  assert.deepEqual(await (await fixtureFetch(f.url + "/api/dictation")).json(), {
    available: false,
    reason: "notConfigured",
    autoSend: false,
  });
  const { messages, closed } = open();
  await closed;
  assert.deepEqual(messages, [{ type: "error", code: "notConfigured" }]);
  assert.equal(deepgram.calls.length, 0);
});

test("a refused key, silence and a second dictation end the stream cleanly", async (t) => {
  const refused = await fakeDeepgram(t, { status: 401 });
  const first = await setup(t, refused);
  const denied = first.open();
  await denied.closed;
  assert.deepEqual(denied.messages, [{ type: "error", code: "auth" }]);
  const audit = await (
    await fixtureFetch(first.f.url + "/api/audit?action=speech.completed")
  ).json();
  assert.equal(audit.events[0].outcome, "failure");

  const deepgram = await fakeDeepgram(t);
  const { f, open } = await setup(t, deepgram);
  f.application.dictation.limits.idleMs = 150;
  const quiet = open();
  await quiet.closed;
  assert.deepEqual(quiet.messages.at(-1), { type: "ended", reason: "idle" });

  f.application.dictation.limits.idleMs = 5000;
  const older = open();
  await until(() => older.messages.some((m) => m.type === "ready"));
  const newer = open();
  await older.closed;
  assert.deepEqual(older.messages.at(-1), { type: "ended", reason: "replaced" });
  await until(() => newer.messages.some((m) => m.type === "ready"));
  // A text frame other than stop is a protocol error.
  newer.ws.send(JSON.stringify({ type: "other" }));
  assert.equal(await newer.closed, 1008);
  await until(() => deepgram.calls.every((call) => call.ws?.readyState === 3));
});

test("a user's dictation is audited as hers, not the owner's", async (t) => {
  const deepgram = await fakeDeepgram(t);
  const { f, open } = await setup(t, deepgram);
  const { user, cookie } = await signedInUser(f);
  const dictation = open({ origin: f.url, headers: { cookie } });
  await until(() => dictation.messages.some((m) => m.type === "ready"));
  dictation.ws.send(JSON.stringify({ type: "stop" }));
  await dictation.closed;
  const audit = await (
    await fixtureFetch(f.url + "/api/audit?action=speech.completed")
  ).json();
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].actorUserId, user.id);
});
