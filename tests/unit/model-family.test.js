import test from "node:test";
import assert from "node:assert/strict";
import {
  familyChanged,
  modelFamily,
} from "../../server/features/assistants/model-family.js";

const connections = {
  get: (id) => {
    const providerId = { or: "openrouter", ep: "endpoint", ep2: "endpoint" }[id];
    if (!providerId) throw new Error("unknown");
    return { providerId };
  },
};
const chatgpt = { connectionId: "openclaw:acct", modelId: "gpt-5.5" };
const or = (modelId) => ({ connectionId: "or", modelId });

test("ChatGPT and openai/ over OpenRouter are one family", () => {
  assert.equal(modelFamily(chatgpt, connections), "openai");
  assert.equal(modelFamily(or("openai/gpt-4.1"), connections), "openai");
  assert.equal(familyChanged(chatgpt, or("openai/gpt-4.1"), connections), false);
});

test("grok and gpt over OpenRouter differ", () => {
  assert.equal(modelFamily(or("x-ai/grok-4.7"), connections), "x-ai");
  assert.equal(
    familyChanged(or("openai/gpt-4.1"), or("x-ai/grok-4.7"), connections),
    true,
  );
});

test("an endpoint model without prefix is its connection's own family", () => {
  const local = { connectionId: "ep", modelId: "llama3" };
  assert.equal(modelFamily(local, connections), "unknown:ep");
  assert.equal(
    modelFamily({ connectionId: "ep", modelId: "qwen/qwen3" }, connections),
    "qwen",
  );
  assert.equal(
    familyChanged(local, { connectionId: "ep2", modelId: "llama3" }, connections),
    true,
  );
  assert.equal(
    familyChanged(local, { connectionId: "ep", modelId: "other" }, connections),
    false,
  );
});

test("same model is unchanged", () => {
  assert.equal(
    familyChanged(or("x-ai/grok-4.7"), or("x-ai/grok-4.7"), connections),
    false,
  );
});
