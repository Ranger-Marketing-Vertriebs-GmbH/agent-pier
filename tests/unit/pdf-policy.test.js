import test from "node:test";
import assert from "node:assert/strict";
import { PdfPolicy } from "../../server/features/assistants/pdf-policy.js";

// Connections: `vision` takes images, `text` does not, `gone` cannot be resolved; a
// ChatGPT account (`openclaw:a1`) is signed in, `openclaw:off` is not.
function fixture({ fallback = null, profiles } = {}) {
  const released = [];
  const agents =
    profiles ??
    [
      {
        id: "v",
        runtimeAgentId: "ap-v",
        model: { connectionId: "vision", modelId: "vl" },
      },
      { id: "t", runtimeAgentId: "ap-t", model: { connectionId: "text", modelId: "tx" } },
      { id: "g", runtimeAgentId: "ap-g", model: { connectionId: "gone", modelId: "tx" } },
      {
        id: "c",
        runtimeAgentId: "ap-c",
        model: { connectionId: "openclaw:a1", modelId: "gpt" },
      },
      {
        id: "o",
        runtimeAgentId: "ap-o",
        model: { connectionId: "openclaw:off", modelId: "gpt" },
      },
    ].map((agent) => ({ ...agent, capabilities: { readPdfs: true } }));
  const assistants = {
    store: { listAssistants: () => agents },
    providerSynchronization: { pdfFallback: fallback },
    models: {
      resolve({ connectionId, modelId }) {
        if (connectionId === "gone") throw Error("provider");
        return {
          providerId: `ap-${connectionId}-1`,
          provider: { models: [{ id: modelId }] },
          modelRef: `ap-${connectionId}-1/${modelId}`,
          release: () => released.push(connectionId),
        };
      },
      imageInput: ({ connectionId }) =>
        connectionId.startsWith("openclaw:") || connectionId === "vision",
      accounts: {
        offlineSelection: (id, modelId) => ({
          modelRef: `openai/${modelId}@profile-${id.slice(9)}`,
          available: id === "openclaw:a1",
        }),
      },
    },
  };
  return { policy: new PdfPolicy({ assistants }), agents, released };
}

test("an agent whose model takes images reads PDFs with its own model", async () => {
  const { policy, released } = fixture({ fallback: "ap-fb-1/fallback" });
  assert.deepEqual(await policy.check({ agentId: "ap-v", sessionKey: "s" }), {
    allow: true,
    model: "ap-vision-1/vl",
  });
  assert.deepEqual(released, ["vision"]);
  assert.deepEqual(await policy.check({ agentId: "ap-c" }), {
    allow: true,
    model: "openai/gpt@profile-a1",
  });
});

test("a text-only agent reads with the started fallback, else its own model", async () => {
  const withFallback = fixture({ fallback: "ap-fb-1/fallback" }).policy;
  assert.deepEqual(await withFallback.check({ agentId: "ap-t" }), {
    allow: true,
    model: "ap-fb-1/fallback",
  });
  // An own model that cannot be resolved reads with the fallback as well.
  assert.deepEqual(await withFallback.check({ agentId: "ap-g" }), {
    allow: true,
    model: "ap-fb-1/fallback",
  });
  const without = fixture().policy;
  // Text only: OpenClaw drops the page images for a model without image input.
  assert.deepEqual(await without.check({ agentId: "ap-t" }), {
    allow: true,
    model: "ap-text-1/tx",
  });
  // Neither its own model nor a fallback: refused, never another model.
  assert.deepEqual(await without.check({ agentId: "ap-g" }), {
    allow: false,
    reason: "unavailable",
  });
  assert.deepEqual(await without.check({ agentId: "ap-o" }), {
    allow: false,
    reason: "unavailable",
  });
});

test("only an agent that may read PDFs gets a model", async () => {
  const { policy, agents } = fixture();
  agents[0].capabilities = { readPdfs: false };
  assert.deepEqual(await policy.check({ agentId: "ap-v" }), {
    allow: false,
    reason: "notGranted",
  });
  agents[1].archivedAt = "2026-10-01T00:00:00.000Z";
  for (const input of [
    { agentId: "ap-t" },
    { agentId: "ap-unknown" },
    { agentId: 7 },
    { agentId: "ap-c", model: "x/y" },
    null,
    [],
  ])
    assert.deepEqual(await policy.check(input), { allow: false, reason: "unavailable" });
});

test("a task member reads PDFs only with its lead's grant", async () => {
  const member = (grant) => ({
    id: "m",
    runtimeAgentId: "ap-m",
    teamMemberId: "t1",
    lifetime: "task",
    model: { connectionId: "vision", modelId: "vl" },
    inherited: {
      capabilities: { readPdfs: grant },
      skills: [],
      shell: "off",
      ssh: false,
    },
  });
  const granted = fixture({ profiles: [member(true)] }).policy;
  assert.equal((await granted.check({ agentId: "ap-m" })).model, "ap-vision-1/vl");
  const denied = fixture({ profiles: [member(false)] }).policy;
  assert.equal((await denied.check({ agentId: "ap-m" })).reason, "notGranted");
});
