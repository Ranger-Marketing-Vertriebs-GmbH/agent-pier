import test from "node:test";
import assert from "node:assert/strict";
import { scriptedUpstream, sse, json } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { authorized } from "../helpers/adapter-fixture.js";
import { startAdapterServer as start, until } from "../helpers/adapter-process.js";

const claudeBody = (extra = {}) => ({
  ...loadFixture("clients/claude-code/text.json").body,
  ...extra,
});
const post = (url, body = claudeBody(), signal) =>
  fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(body),
    signal,
  });
const maxTokensRejected = (res) =>
  json(res, 400, {
    error: {
      message:
        "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
      param: "max_tokens",
    },
  });
const reasoningRejected = (res) =>
  json(res, 400, {
    error: { message: "Unsupported parameter: 'reasoning'", param: "reasoning" },
  });
const FALLBACK = "maxTokensField=max_completion_tokens";

function gate() {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
}

test("a confirmed switch survives the owner's later failed retry", async (t) => {
  // A owns the switch; D, built before it, is rejected too, retries as non-owner and
  // succeeds; A's own retry then fails transiently: the proven value stays.
  const firstA = gate();
  const firstD = gate();
  const retryA = gate();
  const up = await scriptedUpstream(t, async (entry, res) => {
    const { max_tokens: v, max_completion_tokens: f } = entry.body;
    if (v === 1000) return firstA.promise.then(() => maxTokensRejected(res));
    if (v === 2000) return firstD.promise.then(() => maxTokensRejected(res));
    if (f === 1000) {
      await retryA.promise;
      return json(res, 503, { error: { message: "model reloading" } });
    }
    sse(res, loadFixture("upstreams/chat/text.sse"));
  });
  const { url, server } = await start(t, up);
  const a = post(url, claudeBody({ max_tokens: 1000 }));
  const d = post(url, claudeBody({ max_tokens: 2000 }));
  await until(() => up.seen.length === 2);
  firstA.open();
  await until(() => up.seen.some((e) => e.body.max_completion_tokens === 1000));
  firstD.open();
  const second = await d;
  assert.equal(second.status, 200);
  assert.match(await second.text(), /event: message_stop/);
  retryA.open();
  const first = await a;
  assert.equal(first.status, 529); // 503 → Messages overloaded
  assert.match(await first.text(), /model reloading/);
  const snapshot = server.snapshot();
  assert.equal(snapshot.capabilities.maxTokensField, "max_completion_tokens");
  assert.deepEqual(snapshot.capabilityFallbacks, {
    [FALLBACK]: { kept: 1, reverted: 0 },
  });
  // The next request goes out with the confirmed field at once.
  await (await post(url, claudeBody({ max_tokens: 3000 }))).text();
  assert.equal(up.seen.at(-1).body.max_completion_tokens, 3000);
});

test("a client disconnect during the retry restores the capability uncounted", async (t) => {
  const up = await scriptedUpstream(t, (entry, res) => {
    if (entry.body.reasoning) return reasoningRejected(res);
    // The retry never answers; the client leaves meanwhile.
  });
  const { url, server } = await start(t, up, { upstreamProtocol: "responses" });
  const controller = new AbortController();
  const pending = post(url, claudeBody(), controller.signal).catch((error) => error);
  await until(() => up.seen.length === 2);
  assert.equal(server.snapshot().capabilities.reasoningEffort, false);
  controller.abort();
  assert.equal((await pending).name, "AbortError");
  await until(() => server.snapshot().capabilities.reasoningEffort === true);
  await until(() => up.seen[1].closed);
  const snapshot = server.snapshot();
  assert.deepEqual(snapshot.capabilityFallbacks, {});
  assert.equal(snapshot.clientDisconnects, 1);
});

test("a transport failure on the retry renders the retry's failure", async (t) => {
  const up = await scriptedUpstream(t, (entry, res) => {
    if (entry.body.reasoning) return reasoningRejected(res);
    res.socket.destroy();
  });
  const { url, server } = await start(t, up, { upstreamProtocol: "responses" });
  const res = await post(url);
  const text = await res.text();
  assert.notEqual(res.status, 400);
  assert.doesNotMatch(text, /Unsupported parameter/);
  const snapshot = server.snapshot();
  assert.equal(snapshot.errors["transport.network"], 1);
  assert.equal(snapshot.capabilities.reasoningEffort, true);
  assert.deepEqual(snapshot.capabilityFallbacks, {
    "reasoningEffort=false": { kept: 0, reverted: 1 },
  });
});

test("a rebuilt request the translator rejects restores the capability", async (t) => {
  const up = await scriptedUpstream(t, (_entry, res) => reasoningRejected(res));
  const { url, server } = await start(t, up, { upstreamProtocol: "responses" });
  const build = server.ctx.translator.buildUpstream;
  let calls = 0;
  server.ctx.translator.buildUpstream = (body, headers, options) =>
    build(++calls === 2 ? null : body, headers, options);
  const res = await post(url);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Unsupported parameter: 'reasoning'/);
  assert.equal(calls, 2);
  assert.equal(up.seen.length, 1);
  assert.equal(server.snapshot().capabilities.reasoningEffort, true);
  assert.deepEqual(server.snapshot().capabilityFallbacks, {});
});
