import test from "node:test";
import assert from "node:assert/strict";
import {
  requestJson,
  TicketSourceError,
} from "../../server/features/tickets/http-json.js";

test("statuses map to codes without leaking the request", async () => {
  for (const [status, code] of [
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "notFound"],
    [429, "rateLimited"],
    [503, "unavailable"],
  ]) {
    const error = await requestJson({
      url: "https://h/x",
      headers: { "X-API-Key": "secret-token" },
      fetchImpl: async () => new Response("secret-token echoed", { status }),
    }).catch((e) => e);
    assert.ok(error instanceof TicketSourceError);
    assert.equal(error.code, code);
    assert.equal(error.status, 502);
    assert.doesNotMatch(`${error.message} ${error.stack}`, /secret-token|https:\/\/h/);
  }
});

test("a 403 with an empty rate limit is rateLimited", async () => {
  const error = await requestJson({
    url: "https://h/x",
    fetchImpl: async () =>
      new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
  }).catch((e) => e);
  assert.equal(error.code, "rateLimited");
});

test("a hanging server times out as unreachable", async () => {
  const error = await requestJson({
    url: "https://h/x",
    timeoutMs: 50,
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  }).catch((e) => e);
  assert.equal(error.code, "unreachable");
});

test("a network error is unreachable", async () => {
  const error = await requestJson({
    url: "https://h/x",
    fetchImpl: async () => {
      throw new TypeError("fetch failed https://h/x");
    },
  }).catch((e) => e);
  assert.equal(error.code, "unreachable");
  assert.doesNotMatch(error.message, /https:\/\/h/);
});

test("a body over maxBytes or not JSON is invalidResponse", async () => {
  for (const [payload, maxBytes] of [
    [JSON.stringify({ a: "x".repeat(50) }), 10],
    ["<html>", 1000],
  ]) {
    const error = await requestJson({
      url: "https://h/x",
      maxBytes,
      fetchImpl: async () => new Response(payload, { status: 200 }),
    }).catch((e) => e);
    assert.equal(error.code, "invalidResponse");
  }
});

test("a JSON body is parsed and sent with its content type", async () => {
  let seen;
  const result = await requestJson({
    url: "https://h/x",
    method: "POST",
    body: { a: 1 },
    fetchImpl: async (url, init) => {
      seen = init;
      return new Response('{"ok":true}', { status: 201 });
    },
  });
  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.status, 201);
  assert.equal(seen.headers["Content-Type"], "application/json");
  assert.equal(seen.body, '{"a":1}');
});
