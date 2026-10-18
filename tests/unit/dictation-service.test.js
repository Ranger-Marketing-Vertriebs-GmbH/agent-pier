import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DictationService } from "../../server/features/speech/dictation-service.js";

class FakeUpstream extends EventEmitter {
  sent = [];
  terminated = false;
  send(data, done) {
    this.sent.push(Buffer.isBuffer(data) ? Buffer.from(data) : data);
    done?.();
  }
  terminate() {
    this.terminated = true;
  }
}

function harness({ hasSecret = true, limits = {}, now = () => 0 } = {}) {
  const upstreams = [],
    audits = [];
  let leases = 0;
  const speech = {
    get: () => ({ hasSecret, model: "nova-3", language: "de", dictationSend: false }),
    acquire: () => {
      leases++;
      return {
        model: "nova-3",
        language: "de",
        apiKey: "k",
        release: () => leases--,
      };
    },
  };
  const service = new DictationService({
    speech: () => speech,
    audit: { append: (event) => audits.push(event) },
    connect: (url, headers) => {
      const upstream = new FakeUpstream();
      Object.assign(upstream, { url, headers });
      upstreams.push(upstream);
      return upstream;
    },
    clock: { now },
    limits,
  });
  const client = () => {
    const c = { messages: [], closed: null };
    c.send = (message) => c.messages.push(message);
    c.close = (code) => (c.closed ??= code);
    return c;
  };
  return { service, upstreams, audits, client, leases: () => leases };
}

test("audio is forwarded once Deepgram accepts and every sent buffer is zeroed", () => {
  const h = harness();
  const c = h.client();
  const session = h.service.start({ holder: "a", client: c });
  const early = Buffer.alloc(320, 7);
  session.audio(early);
  const [upstream] = h.upstreams;
  assert.equal(upstream.headers.Authorization, "Token k");
  assert.equal(upstream.sent.length, 0);
  upstream.emit("open");
  assert.equal(h.leases(), 0);
  assert.deepEqual(c.messages, [{ type: "ready", maxSeconds: 300 }]);
  const late = Buffer.alloc(320, 9);
  session.audio(late);
  assert.equal(upstream.sent.length, 2);
  assert.equal(upstream.sent[0][0], 7);
  assert.ok(early.every((byte) => byte === 0) && late.every((byte) => byte === 0));
  // An odd number of bytes is not 16-bit PCM.
  session.audio(Buffer.alloc(3));
  assert.deepEqual(c.messages.at(-1), { type: "error", code: "invalid" });
  assert.equal(c.closed, 1000);
  assert.ok(upstream.terminated);
  assert.equal(h.audits[0].outcome, "failure");
});

test("a dictation stops at its maximum length and flushes the last words", async () => {
  const h = harness({ limits: { maxSeconds: 0.03, finishMs: 1000 } });
  const c = h.client();
  h.service.start({ holder: "a", client: c });
  const [upstream] = h.upstreams;
  upstream.emit("open");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(upstream.sent.at(-1), JSON.stringify({ type: "CloseStream" }));
  upstream.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "Results",
        is_final: true,
        channel: { alternatives: [{ transcript: "Ende" }] },
      }),
    ),
    false,
  );
  upstream.emit("close", 1000);
  assert.deepEqual(c.messages.slice(1), [
    { type: "transcript", final: true, text: "Ende" },
    { type: "ended", reason: "limit" },
  ]);
  assert.equal(h.audits.length, 1);
  assert.deepEqual(h.audits[0].details, { kind: "dictation", seconds: 0 });
});

test("an unanswered stop still ends after the finishing window", async () => {
  const h = harness({ limits: { finishMs: 20 } });
  const c = h.client();
  const session = h.service.start({ holder: "a", client: c });
  h.upstreams[0].emit("open");
  session.stop();
  session.stop();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(c.messages.at(-1), { type: "ended", reason: "stopped" });
  assert.equal(h.audits.length, 1);
});

test("starts are rate limited per login session and capped across sessions", () => {
  let now = 0;
  const h = harness({
    limits: { starts: 2, windowMs: 1000, concurrent: 1 },
    now: () => now,
  });
  const one = h.client(),
    two = h.client(),
    three = h.client();
  h.service.start({ holder: "a", client: one });
  h.service.start({ holder: "a", client: two });
  assert.deepEqual(one.messages.at(-1), { type: "ended", reason: "replaced" });
  h.service.start({ holder: "a", client: three });
  assert.deepEqual(three.messages, [{ type: "error", code: "rateLimited" }]);
  const other = h.client();
  h.service.start({ holder: "b", client: other });
  assert.deepEqual(other.messages, [{ type: "error", code: "busy" }]);
  now = 2000;
  const later = h.client();
  h.service.start({ holder: "a", client: later });
  assert.equal(later.closed, null);
  h.service.close();
  assert.deepEqual(later.messages.at(-1), { type: "ended", reason: "closed" });
  assert.equal(h.service.active.size, 0);
});

test("too much audio before Deepgram answers, or no key, ends without a stream", () => {
  const h = harness({ limits: { maxPendingBytes: 100 } });
  const c = h.client();
  const session = h.service.start({ holder: "a", client: c });
  session.audio(Buffer.alloc(64));
  session.audio(Buffer.alloc(64));
  assert.deepEqual(c.messages, [{ type: "error", code: "failed" }]);
  assert.equal(h.leases(), 1, "the handshake still owns its lease until it settles");
  h.upstreams[0].emit("close", 1006);
  assert.equal(h.leases(), 0);

  const missing = harness({ hasSecret: false });
  const refused = missing.client();
  missing.service.start({ holder: "a", client: refused });
  assert.deepEqual(refused.messages, [{ type: "error", code: "notConfigured" }]);
  assert.equal(missing.upstreams.length, 0);
  assert.deepEqual(missing.service.status(), {
    available: false,
    reason: "notConfigured",
    autoSend: false,
  });
  const off = new DictationService({ speech: () => null });
  assert.equal(off.status().reason, "agentsOff");
});
