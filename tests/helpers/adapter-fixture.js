export const TOKEN = "t".repeat(43);
export const KEY = "upstream-secret-key";
export function validAdapterConfig(overrides = {}) {
  return {
    token: TOKEN,
    clientProtocol: "messages",
    upstreamProtocol: "chat",
    upstream: { baseUrl: "http://127.0.0.1:9/v1", authHeader: null, apiKey: KEY },
    model: { modelId: "qwen3", contextTokens: 32768, outputTokens: 8192, images: null },
    capabilities: {},
    thinkTagExtraction: false,
    diagnosticsPath: null,
    generation: null,
    sessionKey: null,
    ...overrides,
  };
}
export const authorized = (extra = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  ...extra,
});
