import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAdapterConfig,
  adapterDiagnosticsPath,
  adapterSessionKey,
  checkedAdapter,
} from "../../server/features/adapter-runtime/adapter-config.js";
import { fallbackOutputTokens } from "../../server/features/providers/endpoint-config.js";
import { validAdapterConfig, KEY } from "../helpers/adapter-fixture.js";

test("a valid configuration passes and is returned unchanged", () => {
  const config = validAdapterConfig({ diagnosticsPath: "/tmp/a.adapter.json" });
  const result = validateAdapterConfig(config);
  assert.deepEqual(result, config);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.upstream), true);
  assert.equal(adapterDiagnosticsPath("/d", "x"), "/d/x.adapter.json");
});

const upstream = (extra) => ({ ...validAdapterConfig().upstream, ...extra });
const model = (extra) => ({ ...validAdapterConfig().model, ...extra });
const invalidCases = {
  token: { token: "short" },
  clientProtocol: { clientProtocol: "chat" },
  upstreamProtocol: { upstreamProtocol: "bogus" },
  "same protocol": { upstreamProtocol: "messages" },
  baseUrl: { upstream: upstream({ baseUrl: "ftp://x/v1" }) },
  "baseUrl normalization": { upstream: upstream({ baseUrl: "http://127.0.0.1:9/v1/" }) },
  "forbidden authHeader": { upstream: upstream({ authHeader: "Host" }) },
  authHeader: { upstream: upstream({ authHeader: "bad header" }) },
  "apiKey control": { upstream: upstream({ apiKey: "secret\u0000x" }) },
  "apiKey length": { upstream: upstream({ apiKey: "s".repeat(16385) }) },
  modelId: { model: model({ modelId: "bad id" }) },
  contextTokens: { model: model({ contextTokens: 10 }) },
  outputTokens: { model: model({ outputTokens: 10_000_001 }) },
  images: { model: model({ images: "yes" }) },
  capabilities: { capabilities: { streamUsage: "nope-secret" } },
  thinkTagExtraction: { thinkTagExtraction: "no" },
  "diagnostics relative": { diagnosticsPath: "relative.json" },
  "diagnostics NUL": { diagnosticsPath: "/tmp/a\0b" },
  generation: { generation: "short" },
  "generation without a session diagnostics file": {
    generation: "g".repeat(16),
    diagnosticsPath: "/tmp/other.json",
  },
  sessionKey: { sessionKey: "bad key with spaces" },
};

for (const [name, overrides] of Object.entries(invalidCases))
  test(`invalid ${name} is refused without echoing values`, () => {
    assert.throws(
      () => validateAdapterConfig(validAdapterConfig(overrides)),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message.includes("secret"), false);
        assert.equal(error.message.includes(KEY), false);
        return true;
      },
    );
  });

test("null optional values are accepted", () => {
  validateAdapterConfig(
    validAdapterConfig({
      upstream: upstream({ apiKey: null, authHeader: "x-api-key" }),
      model: model({ outputTokens: null, images: true }),
    }),
  );
});

test("the session wrapper adds a fresh generation and a stable prompt-cache key", () => {
  const onInvalid = () => new Error("invalid");
  const [a, b] = [1, 2].map(() =>
    checkedAdapter(validAdapterConfig(), "/data/sessions", "session-1", onInvalid),
  );
  assert.equal(a.diagnosticsPath, "/data/sessions/session-1.adapter.json");
  assert.match(a.generation, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(a.generation, b.generation, "every launch is a new generation");
  assert.equal(a.sessionKey, b.sessionKey, "the cache key is stable per session");
  assert.equal(a.sessionKey, adapterSessionKey("session-1"));
  assert.notEqual(a.sessionKey, adapterSessionKey("session-2"));
  assert.equal(a.sessionKey.includes("session-1"), false);
});

test("DEL in an API key is accepted like the account store does", () => {
  validateAdapterConfig(validAdapterConfig({ upstream: upstream({ apiKey: "a\x7fb" }) }));
});

test("unknown capability names are dropped from the payload", () => {
  const result = validateAdapterConfig(
    validAdapterConfig({
      capabilities: { streamUsage: false, bogus: 1, promptCache: true },
    }),
  );
  assert.deepEqual(result.capabilities, { streamUsage: false });
});

test("the output token fallback of a small-context model passes validation", () => {
  assert.equal(fallbackOutputTokens(2048, null), 1024);
  const outputTokens = fallbackOutputTokens(2048, null);
  validateAdapterConfig(
    validAdapterConfig({ model: model({ contextTokens: 2048, outputTokens }) }),
  );
});
