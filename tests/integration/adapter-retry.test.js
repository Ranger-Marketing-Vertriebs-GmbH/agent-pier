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
const post = (url, body = claudeBody()) =>
  fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(body),
  });

test("Responses upstream rejecting reasoning: retry once, keep the fallback after success", async (t) => {
  const up = await scriptedUpstream(t, (entry, res) => {
    if (entry.body.reasoning)
      return json(res, 400, {
        error: {
          message: "Unsupported parameter: 'reasoning.effort'",
          param: "reasoning.effort",
          code: "unsupported_parameter",
        },
      });
    sse(res, loadFixture("upstreams/responses/text.sse"));
  });
  const { url, server } = await start(t, up, { upstreamProtocol: "responses" });
  const ids = [];
  const build = server.ctx.translator.buildUpstream;
  server.ctx.translator.buildUpstream = (body, headers, options) => {
    ids.push(options.requestId);
    return build(body, headers, options);
  };
  for (let i = 0; i < 2; i++) {
    const res = await post(url);
    const text = await res.text();
    assert.match(text, /event: message_stop/);
    if (i === 0) assert.match(text, new RegExp(`"id":"${ids[1]}"`));
  }
  // The retry is a fresh exchange with a new request id.
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(
    up.seen.map((e) => !!e.body.reasoning),
    [true, false, false],
  );
  assert.deepEqual(server.snapshot().capabilityFallbacks["reasoningEffort=false"], {
    kept: 1,
    reverted: 0,
  });
  assert.equal(server.snapshot().capabilities.reasoningEffort, false);
});

test("a failed retry restores the previous capability and shows the retry's error", async (t) => {
  const up = await scriptedUpstream(t, (entry, res) =>
    entry.body.reasoning
      ? json(res, 400, {
          error: { message: "Unsupported parameter: 'reasoning'", param: "reasoning" },
        })
      : json(res, 400, { error: { message: "model not loaded" } }),
  );
  const { url, server } = await start(t, up, { upstreamProtocol: "responses" });
  const res = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(claudeBody()),
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /model not loaded/);
  await (
    await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: authorized(),
      body: JSON.stringify(claudeBody()),
    })
  ).text();
  assert.deepEqual(
    up.seen.map((e) => !!e.body.reasoning),
    [true, false, true, false],
  );
  assert.deepEqual(server.snapshot().capabilityFallbacks["reasoningEffort=false"], {
    kept: 0,
    reverted: 2,
  });
});

test("Chat max_tokens rejection switches to max_completion_tokens", async (t) => {
  const up = await scriptedUpstream(t, (entry, res) =>
    "max_tokens" in entry.body
      ? json(res, 400, {
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            param: "max_tokens",
          },
        })
      : sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const { url } = await start(t, up);
  assert.match(
    await (
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: authorized(),
        body: JSON.stringify(claudeBody()),
      })
    ).text(),
    /message_stop/,
  );
  assert.equal("max_completion_tokens" in up.seen[1].body, true);
});

test("no retry for errors that name no capability", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    json(res, 400, { error: { message: "model not found" } }),
  );
  const { url, server } = await start(t, up, { upstreamProtocol: "responses" });
  const res = await post(url);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /model not found/);
  assert.equal(up.seen.length, 1);
  assert.deepEqual(server.snapshot().capabilityFallbacks, {});
});

test("never more than one retry per request", async (t) => {
  // First the reasoning parameter is refused; the retry (without reasoning) is then refused
  // for prompt_cache_key, which would map to another capability — no second retry.
  const up = await scriptedUpstream(t, (entry, res) => {
    if (entry.body.reasoning)
      return json(res, 400, {
        error: { message: "Unsupported parameter: 'reasoning'", param: "reasoning" },
      });
    if ("prompt_cache_key" in entry.body)
      return json(res, 400, {
        error: {
          message: "Unsupported parameter: 'prompt_cache_key'",
          param: "prompt_cache_key",
        },
      });
    sse(res, loadFixture("upstreams/responses/text.sse"));
  });
  const { url, server } = await start(t, up, {
    upstreamProtocol: "responses",
    capabilities: { promptCacheKey: true },
  });
  const res = await post(url);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /prompt_cache_key/);
  assert.equal(up.seen.length, 2);
  assert.deepEqual(server.snapshot().capabilityFallbacks, {
    "reasoningEffort=false": { kept: 0, reverted: 1 },
  });
  assert.equal(server.snapshot().capabilities.promptCacheKey, true);
});

test("a retry in one request does not break a concurrent stream (Review Focus 4)", async (t) => {
  // A (max_tokens 1000) streams slowly; B (max_tokens 2000) is refused for max_tokens and
  // retried with max_completion_tokens while A is still streaming.
  const [head, tail] = (() => {
    const text = loadFixture("upstreams/chat/text.sse");
    const cut = text.indexOf("\n\n") + 2;
    return [text.slice(0, cut), text.slice(cut)];
  })();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const up = await scriptedUpstream(t, async (entry, res) => {
    if (entry.body.max_tokens === 2000)
      return json(res, 400, {
        error: {
          message:
            "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          param: "max_tokens",
        },
      });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(head);
    if (entry.body.max_tokens === 1000) await gate;
    res.end(tail);
  });
  const { url, server } = await start(t, up);
  const a = post(url, claudeBody({ max_tokens: 1000 }));
  await until(() => up.seen.length === 1);
  const b = await post(url, claudeBody({ max_tokens: 2000 }));
  assert.equal(b.status, 200);
  assert.match(await b.text(), /event: message_stop/);
  release();
  const first = await a;
  assert.equal(first.status, 200);
  assert.match(await first.text(), /event: message_stop/);
  assert.equal(up.seen[2].body.max_completion_tokens, 2000);
  assert.deepEqual(
    server.snapshot().capabilityFallbacks["maxTokensField=max_completion_tokens"],
    {
      kept: 1,
      reverted: 0,
    },
  );
});

const maxTokensRejected = (res) =>
  json(res, 400, {
    error: {
      message:
        "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
      param: "max_tokens",
    },
  });

test("concurrent rejections of the same parameter both retry; one owns the change", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const up = await scriptedUpstream(t, async (entry, res) => {
    if (!("max_tokens" in entry.body))
      return sse(res, loadFixture("upstreams/chat/text.sse"));
    await gate; // both requests are in flight with max_tokens before either is refused
    maxTokensRejected(res);
  });
  const { url, server } = await start(t, up);
  const a = post(url, claudeBody({ max_tokens: 1000 }));
  const b = post(url, claudeBody({ max_tokens: 2000 }));
  await until(() => up.seen.length === 2);
  release();
  for (const res of await Promise.all([a, b])) {
    assert.equal(res.status, 200);
    assert.match(await res.text(), /event: message_stop/);
  }
  assert.equal(up.seen.length, 4);
  assert.deepEqual(
    up.seen
      .slice(2)
      .map((e) => e.body.max_completion_tokens)
      .sort(),
    [1000, 2000],
  );
  assert.deepEqual(server.snapshot().capabilityFallbacks, {
    "maxTokensField=max_completion_tokens": { kept: 1, reverted: 0 },
  });
});

const codexBody = () => ({
  ...loadFixture("clients/codex/text.json").body,
  stream: true,
});
const postCodex = (url) =>
  fetch(`${url}/v1/responses`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(codexBody()),
  });
const streamOptionsRejected = (res) =>
  json(res, 400, {
    error: {
      message: "Unrecognized request argument: stream_options",
      param: "stream_options",
    },
  });
const codexOverChat = { clientProtocol: "responses", upstreamProtocol: "chat" };

test("a Codex stream retries while nothing was written to it", async (t) => {
  const up = await scriptedUpstream(t, (entry, res) =>
    entry.body.stream_options
      ? streamOptionsRejected(res)
      : sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const { url, server } = await start(t, up, codexOverChat);
  const text = await (await postCodex(url)).text();
  assert.match(text, /response\.completed/);
  assert.equal(text.match(/event: response\.created/g).length, 1);
  assert.deepEqual(
    up.seen.map((e) => !!e.body.stream_options),
    [true, false],
  );
  assert.equal(server.snapshot().capabilities.streamUsage, false);
});

test("no retry once a keep-alive reached the client", async (t) => {
  const up = await scriptedUpstream(t, async (_entry, res) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    streamOptionsRejected(res);
  });
  const { url, server } = await start(t, up, codexOverChat, { keepaliveMs: 20 });
  const text = await (await postCodex(url)).text();
  assert.match(text, /response\.in_progress/);
  assert.match(text, /response\.failed/);
  assert.equal(up.seen.length, 1);
  assert.deepEqual(server.snapshot().capabilityFallbacks, {});
  assert.equal(server.snapshot().capabilities.streamUsage, true);
});
