import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAdapterConfig,
  adapterDiagnosticsPath,
} from "../../server/features/adapter-runtime/adapter-config.js";
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
