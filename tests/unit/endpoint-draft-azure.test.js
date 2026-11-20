import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProposal,
  autoProbeModel,
  endpointPayload,
  initialEndpoint,
  missingContextModels,
  usableProtocols,
} from "../../web/features/provider-connections/endpoint-draft.js";
import {
  parseAzureDeploymentUrl,
  withPastedUrl,
} from "../../web/features/provider-connections/azure-url.js";
import { connectionCopy } from "../../web/lib/i18n/messages/connections.js";
import { routeLabel } from "../../web/features/provider-connections/route-label.js";

const manual = (modelId, contextTokens = null) => ({
  modelId,
  label: modelId,
  contextTokens,
  outputTokens: null,
  source: "manual",
  contextEdited: true,
  images: null,
});
const azureDraft = (models = []) => ({ ...initialEndpoint(null, "azure"), models });

test("only an unsupported protocol is unticked by a test", () => {
  const draft = azureDraft([manual("prod", 128000)]);
  const failed = applyProposal(draft, {
    listed: true,
    models: [],
    protocols: { messages: "skipped", responses: "failed", chatCompletions: "failed" },
    reasons: { responses: "modelNotFound", chatCompletions: "auth" },
  });
  assert.deepEqual(failed.protocols, {
    messages: false,
    responses: true,
    chatCompletions: true,
  });
  const unsupported = applyProposal(draft, {
    listed: true,
    models: [],
    protocols: { messages: "skipped", responses: "unsupported", chatCompletions: "ok" },
    reasons: { responses: "notFound" },
  });
  assert.deepEqual(unsupported.protocols, {
    messages: false,
    responses: false,
    chatCompletions: true,
  });
  // A protocol the owner unticked comes back when the test finds it.
  const found = applyProposal(
    { ...draft, protocols: { messages: false, responses: false, chatCompletions: true } },
    {
      listed: true,
      models: [],
      protocols: { messages: "skipped", responses: "ok", chatCompletions: "failed" },
      reasons: {},
    },
  );
  assert.equal(found.protocols.responses, true);
});

test("a re-test drops base models an earlier Azure test added", () => {
  const draft = azureDraft([
    { ...manual("dall-e-3-3.0"), source: "detected", contextEdited: false },
    manual("prod"),
  ]);
  const next = applyProposal(draft, {
    listed: true,
    models: [],
    protocols: { messages: "skipped", responses: "ok", chatCompletions: "ok" },
    reasons: {},
  });
  assert.deepEqual(
    next.models.map((model) => model.modelId),
    ["prod"],
  );
});

test("usable protocols need a ticked protocol and, for Messages, its URL", () => {
  const draft = azureDraft();
  assert.deepEqual(usableProtocols(draft), ["responses", "chatCompletions"]);
  assert.deepEqual(
    usableProtocols({
      ...draft,
      protocols: { messages: true, responses: false, chatCompletions: false },
    }),
    [],
  );
  assert.deepEqual(
    usableProtocols({
      ...draft,
      anthropicBaseUrl: "https://x.example",
      protocols: { messages: true, responses: false, chatCompletions: false },
    }),
    ["messages"],
  );
});

test("Automatic tests the first manually entered model of the draft", () => {
  const detected = { ...manual("base"), source: "detected" };
  assert.equal(autoProbeModel(azureDraft([detected, manual("prod")])), "prod");
  assert.equal(autoProbeModel(azureDraft([detected])), "");
});

test("manual models without a context size are named for the owner", () => {
  const detected = { ...manual("base"), source: "detected" };
  assert.deepEqual(
    missingContextModels(azureDraft([manual("a"), manual("b", 128000), detected])).map(
      (model) => model.modelId,
    ),
    ["a"],
  );
});

test("an Azure deployment URL gives the base URL and the deployment", () => {
  assert.deepEqual(
    parseAzureDeploymentUrl(
      "https://my-res.openai.azure.com/openai/deployments/gpt-4o-prod/chat/completions?api-version=2025-01-01-preview",
    ),
    {
      openaiBaseUrl: "https://my-res.openai.azure.com/openai/v1",
      deployment: "gpt-4o-prod",
    },
  );
  assert.deepEqual(
    parseAzureDeploymentUrl(
      " https://x.cognitiveservices.azure.com/openai/deployments/o4-mini/responses ",
    ),
    {
      openaiBaseUrl: "https://x.cognitiveservices.azure.com/openai/v1",
      deployment: "o4-mini",
    },
  );
  assert.equal(
    parseAzureDeploymentUrl("https://my-res.openai.azure.com/openai/v1"),
    null,
  );
  assert.equal(parseAzureDeploymentUrl("not a url"), null);
  assert.equal(
    parseAzureDeploymentUrl("https://x.openai.azure.com/openai/deployments/%2F..%2F/x"),
    null,
  );
});

test("pasting a deployment URL sets the base URL and offers the deployment as model", () => {
  const url =
    "https://my-res.openai.azure.com/openai/deployments/prod/chat/completions?api-version=2024-10-21";
  const next = withPastedUrl(azureDraft(), url);
  assert.equal(next.openaiBaseUrl, "https://my-res.openai.azure.com/openai/v1");
  assert.equal(next.anthropicBaseUrl, "");
  assert.deepEqual(
    next.models.map(({ modelId, source, contextTokens }) => [
      modelId,
      source,
      contextTokens,
    ]),
    [["prod", "manual", null]],
  );
  assert.equal(next.pastedDeployment, "prod");
  // Pasting it again does not add the deployment twice.
  assert.equal(withPastedUrl(next, url).models.length, 1);
  // Any other address is taken as typed.
  const typed = withPastedUrl(azureDraft(), "https://my-res.openai.azure.com/openai/v1");
  assert.equal(typed.openaiBaseUrl, "https://my-res.openai.azure.com/openai/v1");
  assert.equal(typed.models.length, 0);
  assert.equal(typed.pastedDeployment, undefined);
});

test("OpenCode's Chat route keeps the probed output limit field", () => {
  // Only OpenCode reaches Chat Completions here (Claude Code and Codex are off).
  const draft = {
    ...azureDraft([manual("o4-mini", 200000)]),
    openaiBaseUrl: "https://contoso.openai.azure.com/openai/v1",
    protocols: { messages: false, responses: false, chatCompletions: true },
    routing: { claude: "off", codex: "off", opencode: "auto" },
  };
  const next = applyProposal(draft, {
    listed: true,
    models: [],
    protocols: { messages: "skipped", responses: "skipped", chatCompletions: "ok" },
    reasons: {},
    capabilities: { chatCompletions: { maxTokensField: "max_completion_tokens" } },
  });
  assert.equal(
    endpointPayload(next).adapterCapabilities.chatCompletions.maxTokensField,
    "max_completion_tokens",
  );
});

test("route labels name OpenCode's Chat Completions protocol", () => {
  assert.equal(
    routeLabel({ mode: "native", source: "chatCompletions" }),
    "Chat Completions",
  );
  assert.equal(
    routeLabel({ mode: "native", source: "responses" }),
    connectionCopy.routes.native,
  );
});
