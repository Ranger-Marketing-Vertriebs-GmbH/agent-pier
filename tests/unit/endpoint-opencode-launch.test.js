import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { endpointOpenCodeLaunch } from "../../server/features/providers/endpoint-launch.js";

function launch(t, { source, maxTokensField, outputTokens = null }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-launch-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = { env: { XDG_CONFIG_HOME: home }, args: [] };
  const description = {
    providerKey: "agentpier-endpoint",
    displayName: "Custom endpoint",
    endpoints: {
      messages: null,
      responses: "https://contoso.openai.azure.com/openai/v1",
      chatCompletions: "https://contoso.openai.azure.com/openai/v1",
    },
    auth: { keyEnv: "AGENTPIER_ENDPOINT_API_KEY", header: "api-key" },
    route: { mode: source === "chatCompletions" ? "native" : "sdk", source },
    model: { modelId: "o4-mini", label: "o4-mini", contextTokens: 200000, outputTokens },
  };
  const endpoint = {
    adapterCapabilities: maxTokensField ? { chatCompletions: { maxTokensField } } : {},
  };
  endpointOpenCodeLaunch(result, description, { apiKey: "k" }, "Azure", { endpoint });
  const config = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT);
  return config.provider["agentpier-endpoint"];
}

test("OpenCode on Chat Completions sends the probed max_completion_tokens field", (t) => {
  const provider = launch(t, {
    source: "chatCompletions",
    maxTokensField: "max_completion_tokens",
    outputTokens: 100000,
  });
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  // The SDK spreads model options into the body after its own max_tokens: null
  // replaces that field, and OpenCode caps its output request at 32,000 tokens.
  assert.deepEqual(provider.models["o4-mini"].options, {
    max_completion_tokens: 32000,
    max_tokens: null,
  });
  const small = launch(t, {
    source: "chatCompletions",
    maxTokensField: "max_completion_tokens",
    outputTokens: 8192,
  });
  assert.equal(small.models["o4-mini"].options.max_completion_tokens, 8192);
});

test("OpenCode keeps max_tokens without the probed quirk or on Responses", (t) => {
  const plain = launch(t, { source: "chatCompletions" });
  assert.equal("options" in plain.models["o4-mini"], false);
  const responses = launch(t, {
    source: "responses",
    maxTokensField: "max_completion_tokens",
  });
  assert.equal(responses.npm, "@ai-sdk/openai");
  assert.equal("options" in responses.models["o4-mini"], false);
});
