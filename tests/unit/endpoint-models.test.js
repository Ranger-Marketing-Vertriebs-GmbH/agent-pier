import test from "node:test";
import assert from "node:assert/strict";
import {
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

test("auth headers", () => {
  assert.deepEqual(authHeaders("", null), {});
  assert.deepEqual(authHeaders("k", null), { Authorization: "Bearer k" });
  assert.deepEqual(authHeaders("k", "api-key"), { "api-key": "k" });
});
