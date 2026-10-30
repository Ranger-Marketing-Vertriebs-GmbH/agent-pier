import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { TalkSessions } from "../../server/features/speech/talk-sessions.js";
import { DictationService } from "../../server/features/speech/dictation-service.js";
import {
  deepgramLiveUrl,
  parseLiveMessage,
} from "../../server/features/speech/deepgram-live.js";

test("one talk session per login: a newer one replaces it, others stay", () => {
  const audits = [];
  const talk = new TalkSessions({ audit: { append: (e) => audits.push(e) } });
  const ended = [];
  talk.on("ended", (holder, reason) => ended.push([holder, reason]));
  const first = talk.start("login-a", "chat-1").session;
  const other = talk.start("login-b", "chat-1").session;
  const second = talk.start("login-a", "chat-2").session;
  assert.notEqual(first.id, second.id);
  assert.deepEqual(ended, [["login-a", "replaced"]]);
  assert.equal(talk.current("login-a").id, second.id);
  assert.equal(talk.current("login-b").id, other.id);
  // Stop names its session: a stale id from an older tab ends nothing.
  assert.equal(talk.stop("login-a", first.id), false);
  assert.equal(talk.stop("login-a", second.id), true);
  assert.equal(talk.current("login-a"), null);
  assert.equal(audits.at(-1).details.kind, "talk");
  talk.close();
  assert.deepEqual(ended.at(-1), ["login-b", "closed"]);
});

test("a talk session ends after 30 minutes", () => {
  let now = 1000;
  const talk = new TalkSessions({ clock: { now: () => now } });
  const ended = [];
  talk.on("ended", (holder, reason) => ended.push(reason));
  const { session } = talk.start("login", "chat");
  assert.equal(session.expiresAt - session.startedAt, 30 * 60 * 1000);
  now += 30 * 60 * 1000;
  assert.equal(talk.current("login"), null);
  assert.deepEqual(ended, ["limit"]);
});

test("talk sessions have a start window per login", () => {
  const talk = new TalkSessions({ limits: { starts: 2 } });
  talk.start("login", "chat");
  talk.start("login", "chat");
  assert.deepEqual(talk.start("login", "chat"), { refused: "rateLimited" });
  assert.ok(talk.start("other", "chat").session);
  talk.close();
});

test("talk mode asks Deepgram for the end of each utterance", () => {
  const url = deepgramLiveUrl({ model: "nova-3", language: "de" }, undefined, true);
  assert.equal(url.searchParams.get("utterance_end_ms"), "1500");
  assert.equal(url.searchParams.get("endpointing"), "700");
  assert.equal(url.searchParams.get("vad_events"), "true");
  const plain = deepgramLiveUrl({ model: "nova-3", language: "de" });
  assert.equal(plain.searchParams.has("utterance_end_ms"), false);
  const final = JSON.stringify({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "Wie spät ist es?" }] },
  });
  assert.deepEqual(parseLiveMessage(final, { talk: true }), {
    type: "transcript",
    final: true,
    text: "Wie spät ist es?",
    speechFinal: true,
  });
  assert.deepEqual(parseLiveMessage(final), {
    type: "transcript",
    final: true,
    text: "Wie spät ist es?",
  });
  const end = JSON.stringify({ type: "UtteranceEnd", last_word_end: 2.1 });
  assert.deepEqual(parseLiveMessage(end, { talk: true }), { type: "utteranceEnd" });
  assert.equal(parseLiveMessage(end), null);
});

class FakeUpstream extends EventEmitter {
  send() {}
  terminate() {}
}
function dictationHarness({ now = () => 0 } = {}) {
  const talk = new TalkSessions({ clock: { now } });
  const upstreams = [];
  const service = new DictationService({
    speech: () => ({
      get: () => ({ hasSecret: true, model: "nova-3", language: "de" }),
      acquire: () => ({ model: "nova-3", language: "de", apiKey: "k", release() {} }),
    }),
    talk: () => talk,
    connect: (url) => {
      const upstream = Object.assign(new FakeUpstream(), { url });
      upstreams.push(upstream);
      return upstream;
    },
    clock: { now },
    limits: { starts: 1 },
  });
  talk.on("ended", (holder) => service.endTalk(holder));
  const client = () => {
    const c = { messages: [], closed: null };
    c.send = (message) => c.messages.push(message);
    c.close = (code) => (c.closed ??= code);
    return c;
  };
  return { talk, service, upstreams, client };
}

test("a talk dictation needs the login's running talk session and the owner", () => {
  const h = dictationHarness();
  const none = h.client();
  h.service.start({ holder: "login", client: none, talk: "missing-session" });
  assert.deepEqual(none.messages, [{ type: "error", code: "talkEnded" }]);
  const { session } = h.talk.start("login", "chat");
  const user = h.client();
  h.service.start({
    holder: "login",
    principal: { role: "user", userId: "anna" },
    client: user,
    talk: session.id,
  });
  assert.deepEqual(user.messages, [{ type: "error", code: "talkUnavailable" }]);
  // Turns of a talk session do not use up the dictation start window.
  for (let turn = 0; turn < 3; turn++) {
    const c = h.client();
    h.service.start({ holder: "login", client: c, talk: session.id });
    assert.deepEqual(c.messages, []);
  }
  assert.equal(h.upstreams.at(-1).url.searchParams.get("utterance_end_ms"), "1500");
  const last = h.client();
  h.service.start({ holder: "login", client: last, talk: session.id });
  // Stopping the session ends its running dictation.
  h.talk.stop("login", session.id);
  assert.deepEqual(last.messages, [{ type: "ended", reason: "talkEnded" }]);
  assert.equal(last.closed, 1000);
});
