import test from "node:test";
import assert from "node:assert/strict";
import {
  argsContext,
  parseOllamaNumCtx,
  mergeModels,
} from "../../server/features/providers/endpoint-models.js";
import { authHeaders } from "../../server/features/providers/endpoint-http.js";

test("parses num_ctx from Modelfile parameters", () => {
  assert.equal(parseOllamaNumCtx("temperature 0.7\nnum_ctx   16384\n"), 16384);
  assert.equal(parseOllamaNumCtx("temperature 0.7"), null);
  assert.equal(parseOllamaNumCtx(undefined), null);
  assert.equal(parseOllamaNumCtx("num_ctx 12"), null); // below 1024 is ignored
});

test("reads llama.cpp router context from launch arguments", () => {
  assert.equal(argsContext(["llama-server", "-c", "8192"]), 8192);
  assert.equal(argsContext(["llama-server", "--ctx-size", "32768"]), 32768);
  assert.equal(argsContext(["llama-server", "--ctx-size=16384"]), 16384);
  assert.equal(argsContext(["llama-server", "-ctx", "4096"]), 4096);
  assert.equal(argsContext(["llama-server", "-c", "0"]), null); // 0 means model default
  assert.equal(argsContext(["llama-server", "-m", "x.gguf"]), null);
  assert.equal(argsContext(undefined), null);
});

test("merge keeps manual models and edits, replaces detected ones only after listing", () => {
  const previous = [
    {
      modelId: "a",
      label: "a",
      contextTokens: 8192,
      outputTokens: null,
      source: "detected",
      contextEdited: false,
    },
    {
      modelId: "b",
      label: "b",
      contextTokens: 50000,
      outputTokens: 4096,
      source: "detected",
      contextEdited: true,
    },
    {
      modelId: "deploy",
      label: "deploy",
      contextTokens: 128000,
      outputTokens: null,
      source: "manual",
      contextEdited: true,
    },
  ];
  const detection = {
    listed: true,
    models: [
      { modelId: "b", label: "b", contextTokens: 32768, source: "detected" },
      { modelId: "deploy", label: "deploy", contextTokens: 200000, source: "detected" },
      {
        modelId: "c",
        label: "c",
        contextTokens: null,
        contextHint: 131072,
        source: "detected",
      },
    ],
  };
  assert.deepEqual(mergeModels(previous, detection), [
    {
      modelId: "b",
      label: "b",
      contextTokens: 50000,
      outputTokens: 4096,
      source: "detected",
      contextEdited: true,
    },
    {
      modelId: "deploy",
      label: "deploy",
      contextTokens: 128000,
      outputTokens: null,
      source: "detected",
      contextEdited: true,
    },
    {
      modelId: "c",
      label: "c",
      contextTokens: null,
      outputTokens: null,
      source: "detected",
      contextEdited: false,
      contextHint: 131072,
    },
  ]);
  assert.deepEqual(mergeModels(previous, { listed: false, models: [] }), previous);
});

const detectedModel = (modelId) => ({
  modelId,
  label: modelId,
  contextTokens: null,
  source: "detected",
});
const manualModel = (modelId) => ({
  modelId,
  label: modelId,
  contextTokens: 128000,
  outputTokens: null,
  source: "manual",
  contextEdited: true,
});

test("merge keeps every manual model and caps detected models at 200 in total", () => {
  const previous = [
    manualModel("deploy-a"),
    manualModel("deploy-b"),
    manualModel("m-199"),
  ];
  const detection = {
    listed: true,
    models: Array.from({ length: 200 }, (_, index) => detectedModel(`m-${index}`)),
  };
  const merged = mergeModels(previous, detection);
  assert.equal(merged.length, 200);
  const ids = merged.map((model) => model.modelId);
  for (const id of ["deploy-a", "deploy-b", "m-199"]) assert.ok(ids.includes(id), id);
  // A manual model that is also listed becomes detected and survives the cap.
  assert.equal(merged.find((model) => model.modelId === "m-199").source, "detected");
  assert.deepEqual(ids.slice(0, 3), ["m-0", "m-1", "m-2"]);
  assert.ok(!ids.includes("m-198"));
  assert.equal(new Set(ids).size, 200);
});

test("auth headers", () => {
  assert.deepEqual(authHeaders("", null), {});
  assert.deepEqual(authHeaders("k", null), { Authorization: "Bearer k" });
  assert.deepEqual(authHeaders("k", "api-key"), { "api-key": "k" });
});
