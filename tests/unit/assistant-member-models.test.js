import test from "node:test";
import assert from "node:assert/strict";
import {
  listMemberModels,
  memberModelsInput,
} from "../../server/features/assistants/member-models.js";

const openRouterRows = [
  {
    providerId: "openrouter",
    modelId: "anthropic/claude-sonnet",
    label: "Claude Sonnet",
    contextTokens: 200000,
    outputTokens: 64000,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    capabilities: { toolCalling: true, reasoning: true, imageInput: true },
  },
  {
    providerId: "openrouter",
    modelId: "meta/llama",
    label: "Llama",
    contextTokens: 128000,
    outputTokens: null,
    pricing: { inputPerMTok: null, outputPerMTok: null },
    capabilities: { toolCalling: true, reasoning: false, imageInput: false },
  },
];

function sources({ openRouterKey = true, signedIn = true } = {}) {
  const listed = [];
  const catalog = {
    list(filter) {
      listed.push(filter);
      return structuredClone(openRouterRows);
    },
  };
  const models = {
    listCapabilities: () => [
      {
        id: "openclaw:abc",
        name: "ChatGPT",
        providerId: "openai-chatgpt",
        available: signedIn,
        models: [{ modelId: "gpt-5", label: "GPT-5" }],
      },
      {
        id: "router",
        name: "Router",
        providerId: "openrouter",
        available: openRouterKey,
        ...(openRouterKey ? {} : { reason: "credentialsRequired" }),
      },
      {
        id: "local",
        name: "Local",
        providerId: "endpoint",
        available: true,
        models: [
          { modelId: "qwen", label: "Qwen", contextTokens: 32000, outputTokens: 8000 },
        ],
      },
      {
        id: "broken",
        name: "Broken",
        providerId: "endpoint",
        available: false,
        reason: "modelConfiguration",
        models: [],
      },
    ],
    imageInput: ({ connectionId, modelId }) =>
      connectionId.startsWith("openclaw:") ||
      (connectionId === "local" && modelId === "qwen"),
  };
  return { models, catalog, listed };
}

const lead = { id: "lead", model: { connectionId: "router", modelId: "meta/llama" } };
const members = [
  {
    memberId: "m1",
    name: "Scout",
    model: { connectionId: "local", modelId: "qwen" },
  },
  {
    memberId: "m2",
    name: "Writer",
    model: { connectionId: "router", modelId: "meta/llama" },
  },
];

test("lists the models of all three sources, priced only from OpenRouter", () => {
  const { models, catalog, listed } = sources();
  const result = listMemberModels({ models, catalog, lead, members });
  assert.deepEqual(listed, [{ providerId: "openrouter" }]);
  assert.equal(result.total, 4);
  assert.deepEqual(result.models, [
    {
      connectionId: "openclaw:abc",
      connection: "ChatGPT",
      provider: "openai-chatgpt",
      modelId: "gpt-5",
      label: "GPT-5",
      contextTokens: null,
      outputTokens: null,
      reasoning: null,
      imageInput: true,
      pricing: null,
    },
    {
      connectionId: "local",
      connection: "Local",
      provider: "endpoint",
      modelId: "qwen",
      label: "Qwen",
      contextTokens: 32000,
      outputTokens: 8000,
      reasoning: null,
      imageInput: true,
      pricing: null,
    },
    {
      connectionId: "router",
      connection: "Router",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet",
      label: "Claude Sonnet",
      contextTokens: 200000,
      outputTokens: 64000,
      reasoning: true,
      imageInput: true,
      pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    },
    {
      connectionId: "router",
      connection: "Router",
      provider: "openrouter",
      modelId: "meta/llama",
      label: "Llama",
      contextTokens: 128000,
      outputTokens: null,
      reasoning: false,
      imageInput: false,
      pricing: { inputPerMTok: null, outputPerMTok: null },
    },
  ]);
});

test("unavailable connections are left out", () => {
  const { models, catalog, listed } = sources({ openRouterKey: false, signedIn: false });
  const result = listMemberModels({ models, catalog, lead, members });
  assert.deepEqual(
    result.models.map((m) => m.modelId),
    ["qwen"],
  );
  // Without a usable OpenRouter connection its catalog is never read.
  assert.deepEqual(listed, []);
});

test("query filters on model id, label and connection name, ignoring case", () => {
  const { models, catalog } = sources();
  const ids = (query) =>
    listMemberModels({ models, catalog, lead, members, query }).models.map(
      (m) => m.modelId,
    );
  assert.deepEqual(ids("CLAUDE"), ["anthropic/claude-sonnet"]);
  assert.deepEqual(ids("meta/"), ["meta/llama"]);
  assert.deepEqual(ids("chatgpt"), ["gpt-5"]);
  assert.deepEqual(ids("router"), ["anthropic/claude-sonnet", "meta/llama"]);
  assert.deepEqual(ids("nothing"), []);
});

test("limit caps the list and total counts every match", () => {
  const { models, catalog } = sources();
  const result = listMemberModels({ models, catalog, lead, members, limit: 2 });
  assert.equal(result.total, 4);
  assert.deepEqual(
    result.models.map((m) => m.modelId),
    ["gpt-5", "qwen"],
  );
  const filtered = listMemberModels({
    models,
    catalog,
    lead,
    members,
    query: "router",
    limit: 1,
  });
  assert.equal(filtered.total, 2);
  assert.equal(filtered.models.length, 1);
});

test("current names the lead's and each member's effective model", () => {
  const { models, catalog } = sources();
  // A filter never hides what the lead and its members run on.
  const result = listMemberModels({ models, catalog, lead, members, query: "gpt" });
  assert.deepEqual(result.current, {
    lead: {
      connectionId: "router",
      modelId: "meta/llama",
      connection: "Router",
      label: "Llama",
      pricing: { inputPerMTok: null, outputPerMTok: null },
    },
    members: [
      {
        memberId: "m1",
        name: "Scout",
        model: {
          connectionId: "local",
          modelId: "qwen",
          connection: "Local",
          label: "Qwen",
          pricing: null,
        },
      },
      {
        memberId: "m2",
        name: "Writer",
        model: {
          connectionId: "router",
          modelId: "meta/llama",
          connection: "Router",
          label: "Llama",
          pricing: { inputPerMTok: null, outputPerMTok: null },
        },
      },
    ],
  });
  // A model no longer offered keeps its ids.
  const gone = listMemberModels({
    models,
    catalog,
    lead: { model: { connectionId: "old", modelId: "x" } },
    members: [],
  });
  assert.deepEqual(gone.current.lead, { connectionId: "old", modelId: "x" });
});

test("the tool input takes an optional query and limit, nothing else", () => {
  assert.deepEqual(memberModelsInput({}), { query: "", limit: 50 });
  assert.deepEqual(memberModelsInput({ query: " Claude ", limit: 200 }), {
    query: "claude",
    limit: 200,
  });
  for (const input of [
    null,
    [],
    { other: 1 },
    { query: 3 },
    { query: "x".repeat(101) },
    { limit: 0 },
    { limit: 201 },
    { limit: 1.5 },
    { limit: "10" },
    { limit: null },
  ])
    assert.throws(() => memberModelsInput(input), { status: 400 }, JSON.stringify(input));
});

test("a ChatGPT account is never named by its e-mail to the lead", () => {
  const account = (hash, name) => ({
    id: `openclaw:${hash}`,
    name,
    providerId: "openai-chatgpt",
    available: true,
    models: [{ modelId: "gpt-5", label: "GPT-5" }],
  });
  const catalog = { list: () => [] };
  const listed = (accounts) =>
    listMemberModels({
      models: { listCapabilities: () => accounts, imageInput: () => true },
      catalog,
      lead: { model: { connectionId: accounts[0].id, modelId: "gpt-5" } },
      members: [],
    });
  const one = listed([account("a1b2c3d4e5f6", "owner@example.com")]);
  assert.equal(one.models[0].connection, "ChatGPT");
  assert.equal(one.current.lead.connection, "ChatGPT");
  const two = listed([
    account("a1b2c3d4e5f6", "owner@example.com"),
    account("ffeeddccbbaa", "other@example.com"),
  ]);
  // Several accounts stay apart by a short piece of their id, never their name.
  assert.deepEqual(
    two.models.map((m) => m.connection),
    ["ChatGPT a1b2c3", "ChatGPT ffeedd"],
  );
  assert.doesNotMatch(JSON.stringify([one, two]), /@|example\.com/);
  // The query matches the shown name, not the hidden one.
  const found = listMemberModels({
    models: {
      listCapabilities: () => [account("a1b2c3d4e5f6", "owner@example.com")],
      imageInput: () => true,
    },
    catalog,
    lead: null,
    query: "owner",
  });
  assert.equal(found.total, 0);
});
