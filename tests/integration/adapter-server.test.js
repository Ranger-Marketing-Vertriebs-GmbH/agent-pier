import test from "node:test";
import assert from "node:assert/strict";
import { scriptedUpstream, sse, json } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { TOKEN, KEY, authorized } from "../helpers/adapter-fixture.js";
import { startAdapterServer as start } from "../helpers/adapter-process.js";
import { MAX_REQUEST_BODY_BYTES } from "../../server/features/adapter-runtime/adapter-server.js";
import {
  routeFor,
  tokenMatches,
} from "../../server/features/adapter-runtime/adapter-http.js";

const claudeBody = () => loadFixture("clients/claude-code/text.json").body;
const codexBody = () => loadFixture("clients/codex/text.json").body;

test("token auth: Bearer and x-api-key accepted, others 401 without echo", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const { url, server } = await start(t, up);
  const body = JSON.stringify(claudeBody());
  for (const headers of [{ authorization: `Bearer ${TOKEN}` }, { "x-api-key": TOKEN }])
    assert.equal(
      (
        await fetch(`${url}/v1/messages?beta=true`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body,
        })
      ).status,
      200,
    );
  for (const headers of [
    {},
    { authorization: `Bearer ${"u".repeat(43)}` },
    { authorization: "Bearer short" },
    { "x-api-key": KEY },
  ]) {
    const res = await fetch(`${url}/v1/messages`, { method: "POST", headers, body });
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.match(text, /authentication_error/);
    assert.equal(text.includes(KEY) || text.includes("Bearer"), false);
  }
  assert.equal(up.seen.length, 2);
  const snapshot = server.snapshot();
  assert.equal(snapshot.unauthorized, 4);
  assert.deepEqual(snapshot.requests, { "/v1/messages": 2 });
});

test("tokenMatches and routeFor cover both clients", () => {
  assert.equal(tokenMatches(TOKEN, { authorization: `bearer ${TOKEN}` }), true);
  assert.equal(tokenMatches(TOKEN, { "x-api-key": "", authorization: "" }), false);
  assert.equal(tokenMatches(TOKEN, { "x-api-key": `${TOKEN}x` }), false);
  assert.equal(tokenMatches(TOKEN, { "x-api-key": TOKEN.slice(0, -1) }), false);
  assert.equal(
    tokenMatches(TOKEN, { "x-api-key": "wrong", authorization: `Bearer ${TOKEN}` }),
    true,
  );
  assert.equal(routeFor("messages", "POST", "/v1/messages"), "inference");
  assert.equal(routeFor("messages", "GET", "/v1/messages"), "notFound");
  assert.equal(routeFor("messages", "HEAD", "/api/hello"), "hello");
  assert.equal(routeFor("messages", "POST", "/v1/messages/count_tokens"), "notFound");
  assert.equal(routeFor("responses", "POST", "/responses"), "inference");
  assert.equal(routeFor("responses", "POST", "/v1/responses"), "inference");
  assert.equal(routeFor("responses", "HEAD", "/api/hello"), "notFound");
});

test("hello probes and unknown paths", async (t) => {
  const up = await scriptedUpstream(t, () => assert.fail("no upstream call expected"));
  const { url } = await start(t, up);
  assert.equal((await fetch(`${url}/api/hello`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${url}/api/hello`)).status, 401);
  assert.equal((await fetch(`${url}/api/hello`, { headers: authorized() })).status, 200);
  const counted = await fetch(`${url}/v1/messages/count_tokens`, {
    method: "POST",
    headers: authorized(),
    body: "{}",
  });
  assert.equal(counted.status, 404);
  assert.match(await counted.text(), /not_found_error/);
  assert.equal((await fetch(`${url}/v1/models`, { headers: authorized() })).status, 404);
});

test("count_tokens is answered 404 without the upstream and counted separately", async (t) => {
  const up = await scriptedUpstream(t, () => assert.fail("no upstream call expected"));
  const { url, server } = await start(t, up);
  for (let i = 0; i < 2; i += 1) {
    const res = await fetch(`${url}/v1/messages/count_tokens?beta=true`, {
      method: "POST",
      headers: authorized(),
      body: JSON.stringify(claudeBody()),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.type, "not_found_error");
  }
  await (await fetch(`${url}/v1/models`, { headers: authorized() })).text();
  assert.deepEqual(server.snapshot().requests, {
    "/v1/messages/count_tokens": 2,
    other: 1,
  });
  assert.equal(up.seen.length, 0);
});

test("the Responses client does not serve /api/hello", async (t) => {
  const up = await scriptedUpstream(t, () => assert.fail("no upstream call expected"));
  const { url } = await start(t, up, { clientProtocol: "responses" });
  assert.equal((await fetch(`${url}/api/hello`, { headers: authorized() })).status, 404);
  assert.equal((await fetch(`${url}/api/hello`, { method: "HEAD" })).status, 401);
});

test("Responses client paths and 404 format", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const { url } = await start(t, up, { clientProtocol: "responses" });
  for (const path of ["/responses", "/v1/responses"]) {
    const res = await fetch(url + path, {
      method: "POST",
      headers: authorized(),
      body: JSON.stringify(codexBody()),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /event: response\.completed/);
  }
  const missing = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: "{}",
  });
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /not_found_error/); // Responses error shape, not Anthropic
});

test("upstream sees only the real key and protocol headers", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const { url } = await start(t, up);
  await (
    await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: authorized({ "anthropic-beta": "x", "x-claude-code-session-id": "s" }),
      body: JSON.stringify(claudeBody()),
    })
  ).text();
  const headers = up.seen[0].headers;
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.equal(headers["anthropic-beta"], undefined);
  assert.equal(headers["x-claude-code-session-id"], undefined);
  assert.equal(headers.accept, "text/event-stream");
  assert.equal(JSON.stringify(up.seen[0]).includes(TOKEN), false);
  assert.equal(up.seen[0].url, "/v1/chat/completions");
});

test("context overflow maps per client", async (t) => {
  const overflow = loadFixture("upstreams/chat/context-vllm.json");
  const up = await scriptedUpstream(t, (_e, res) =>
    json(res, overflow.status ?? 400, overflow.body ?? overflow),
  );
  const messages = await start(t, up);
  const a = await fetch(`${messages.url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(claudeBody()),
  });
  assert.equal(a.status, 400);
  assert.match(await a.text(), /prompt is too long|exceed context limit/);
  const responses = await start(t, up, { clientProtocol: "responses" });
  const b = await fetch(`${responses.url}/v1/responses`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(codexBody()),
  });
  assert.equal(b.status, 200);
  assert.match(await b.text(), /context_length_exceeded/);
  assert.deepEqual(messages.server.snapshot().upstreamStatus, { "4xx": 1 });
});

test("upstream messages are redacted and request bodies over the cap are refused", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    json(res, 400, { error: { message: `bad key ${KEY} ${TOKEN}` } }),
  );
  const { url } = await start(t, up, {}, { maxBodyBytes: 4096 });
  const small = {
    model: "qwen3",
    max_tokens: 64,
    stream: false,
    messages: [{ role: "user", content: "hello" }],
  };
  const text = await (
    await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: authorized(),
      body: JSON.stringify(small),
    })
  ).text();
  assert.match(text, /bad key/);
  assert.equal(text.includes(KEY) || text.includes(TOKEN), false);
  const big = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: "x".repeat(5000),
  });
  assert.equal(big.status, 400);
  assert.equal(big.headers.get("connection"), "close");
  const error = await big.json();
  assert.equal(error.type, "error");
  assert.equal(error.error.type, "invalid_request_error");
  assert.match(error.error.message, /request body exceeds 4096 bytes/);
  assert.equal(up.seen.length, 1);
});

test("the request body cap is 64 MiB and refusals use the Responses format", async (t) => {
  assert.equal(MAX_REQUEST_BODY_BYTES, 64 * 1024 * 1024);
  const up = await scriptedUpstream(t, () => assert.fail("no upstream call expected"));
  const { url } = await start(
    t,
    up,
    { clientProtocol: "responses" },
    { maxBodyBytes: 2 * 1024 * 1024 },
  );
  const big = await fetch(`${url}/v1/responses`, {
    method: "POST",
    headers: authorized(),
    body: "x".repeat(2 * 1024 * 1024 + 1),
  });
  assert.equal(big.status, 400);
  const { error } = await big.json();
  assert.equal(error.type, "invalid_request_error");
  assert.equal(error.message, "request body exceeds 2 MiB");
});

test("non-streaming requests get a JSON message", async (t) => {
  const fixture = loadFixture("upstreams/messages/non-stream.json"); // { status, headers, body }
  const up = await scriptedUpstream(t, (_e, res) =>
    json(res, fixture.status, fixture.body),
  );
  const { url } = await start(t, up, {
    clientProtocol: "responses",
    upstreamProtocol: "messages",
    upstream: { baseUrl: up.base, authHeader: "x-api-key", apiKey: KEY },
  });
  const res = await fetch(`${url}/v1/responses`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify({ ...codexBody(), stream: false }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).object, "response");
  assert.equal(up.seen[0].headers["x-api-key"], KEY);
  assert.equal(up.seen[0].headers.accept, "application/json");
});

test("invalid JSON is rendered by the translator without an upstream call", async (t) => {
  const up = await scriptedUpstream(t, () => assert.fail("no upstream call expected"));
  const { url, server } = await start(t, up);
  const res = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.type, "invalid_request_error");
  assert.equal(server.snapshot().errors["request.invalid"], 1);
});

test("an unexpected handler exception becomes a 500 and the server keeps serving", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) => json(res, 400, { error: "nope" }));
  const { url, server } = await start(t, up);
  server.ctx.retry = () => {
    throw new Error("boom");
  };
  const request = () =>
    fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: authorized(),
      body: JSON.stringify({ ...claudeBody(), stream: false }),
    });
  const res = await request();
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.match(text, /api_error/);
  assert.doesNotMatch(text, /boom/);
  assert.equal(server.snapshot().errors["adapter.internal"], 1);
  delete server.ctx.retry;
  assert.equal((await request()).status, 400);
});

test("a crash restart continues the previous counters and learned capabilities", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const previous = {
    version: 1,
    requests: { "/v1/messages": 2 },
    unauthorized: 3,
    upstreamStatus: { "2xx": 2 },
    errors: { broken: "not a number" },
    capabilities: { streamUsage: false, bogus: 1 },
    capabilityFallbacks: { "streamUsage=false": { kept: 1, reverted: 0 } },
  };
  const { url, server } = await start(t, up, {}, { previous, restarts: 1 });
  const res = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(claudeBody()),
  });
  assert.match(await res.text(), /message_stop/);
  assert.equal(up.seen[0].body.stream_options, undefined, "learned value is used");
  const snapshot = server.snapshot();
  assert.deepEqual(snapshot.requests, { "/v1/messages": 3 });
  assert.equal(snapshot.unauthorized, 3);
  assert.deepEqual(snapshot.upstreamStatus, { "2xx": 3 });
  assert.deepEqual(snapshot.errors, {});
  assert.equal(snapshot.capabilities.streamUsage, false);
  assert.equal(Object.hasOwn(snapshot.capabilities, "bogus"), false);
  assert.deepEqual(snapshot.capabilityFallbacks, {
    "streamUsage=false": { kept: 1, reverted: 0 },
  });
  // An invalid learned value is ignored: the configured capabilities apply.
  const other = await start(
    t,
    up,
    {},
    { previous: { capabilities: { streamUsage: "x" } } },
  );
  assert.equal(other.server.snapshot().capabilities.streamUsage, true);
});
