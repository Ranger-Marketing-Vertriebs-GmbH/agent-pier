import test from "node:test";
import assert from "node:assert/strict";
import { fakeEndpoint, azureRoutes } from "../helpers/endpoint-servers.js";
import {
  chooseProbeModel,
  runEndpointTest,
} from "../../server/features/providers/endpoint-probe.js";

const manual = (modelId, contextTokens = null) => ({
  modelId,
  label: modelId,
  contextTokens,
  outputTokens: null,
  source: "manual",
  contextEdited: true,
});
const detected = (modelId) => ({
  modelId,
  label: modelId,
  contextTokens: null,
  outputTokens: null,
  source: "detected",
  contextEdited: false,
});
const azure = (base) => ({
  preset: "azure",
  openaiBaseUrl: `${base}/openai/v1`,
  anthropicBaseUrl: null,
  authHeader: "api-key",
});
const probes = (server) => server.seen.filter((entry) => entry.method === "POST");

test("Automatic prefers a manually entered model over the first detected one", () => {
  const detection = { listed: true, models: [detected("dall-e-3-3.0")] };
  assert.equal(
    chooseProbeModel({
      preset: "custom",
      previousModels: [detected("dall-e-3-3.0"), manual("my-deploy")],
      detection,
    }),
    "my-deploy",
  );
  assert.equal(
    chooseProbeModel({ preset: "custom", previousModels: [], detection }),
    "dall-e-3-3.0",
  );
  assert.equal(
    chooseProbeModel({
      preset: "custom",
      probeModelId: "chosen",
      previousModels: [manual("my-deploy")],
      detection,
    }),
    "chosen",
  );
});

test("Automatic never picks a detected base model for the Azure preset", () => {
  const detection = { listed: true, models: [detected("dall-e-3-3.0")] };
  assert.equal(
    chooseProbeModel({
      preset: "azure",
      previousModels: [detected("gpt-4.1")],
      detection,
    }),
    null,
  );
  assert.equal(
    chooseProbeModel({ preset: "azure", previousModels: [manual("prod")], detection }),
    "prod",
  );
});

test("an Azure test probes the saved deployment, not the first base model", async (t) => {
  const server = await fakeEndpoint(t, azureRoutes("az-key"));
  const result = await runEndpointTest({
    endpoint: azure(server.base),
    apiKey: "az-key",
    previousModels: [manual("my-deploy")],
  });
  assert.equal(result.probeModelId, "my-deploy");
  assert.equal(result.protocols.responses, "ok");
  assert.ok(probes(server).every((entry) => entry.body.model === "my-deploy"));
});

test("an Azure test without a deployment probes nothing and asks for one", async (t) => {
  const server = await fakeEndpoint(t, azureRoutes("az-key"));
  const result = await runEndpointTest({
    endpoint: azure(server.base),
    apiKey: "az-key",
  });
  assert.equal(result.probeModelId, null);
  assert.deepEqual(result.protocols, {
    messages: "skipped",
    responses: "skipped",
    chatCompletions: "skipped",
  });
  assert.ok(result.warnings.includes("deploymentRequired"));
  assert.equal(probes(server).length, 0);
});

test("Azure base models are a hint, never models of the connection", async (t) => {
  const server = await fakeEndpoint(t, azureRoutes("az-key"));
  const result = await runEndpointTest({
    endpoint: azure(server.base),
    apiKey: "az-key",
    // An earlier test filled the form with base models; a deployment that shares a
    // base model's name stays manual.
    previousModels: [detected("dall-e-3-3.0"), manual("gpt-4.1", 128000)],
  });
  assert.equal(result.listed, true);
  assert.deepEqual(
    result.models.map(({ modelId, source }) => [modelId, source]),
    [["gpt-4.1", "manual"]],
  );
  assert.ok(result.warnings.includes("azureBaseModels"));
  assert.ok(!result.warnings.includes("modelListTruncated"));
});

test("an Azure 404 for an unknown deployment names the model, not the protocol", async (t) => {
  const server = await fakeEndpoint(t, azureRoutes("az-key"));
  const result = await runEndpointTest({
    endpoint: azure(server.base),
    apiKey: "az-key",
    probeModelId: "gpt-4.1",
  });
  assert.equal(result.protocols.responses, "failed");
  assert.equal(result.reasons.responses, "modelNotFound");
});
