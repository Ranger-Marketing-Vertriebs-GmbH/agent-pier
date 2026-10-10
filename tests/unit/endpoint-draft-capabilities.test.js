// tests/unit/endpoint-draft-capabilities.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProposal,
  capabilityOrigin,
  endpointPayload,
  initialEndpoint,
  resetCapabilities,
  setCapability,
  setRoute,
  withoutTest,
} from "../../web/features/provider-connections/endpoint-draft.js";

const chatOnly = {
  messages: "unsupported",
  responses: "unsupported",
  chatCompletions: "ok",
};
const proposal = (capabilities, protocols = chatOnly) => ({
  listed: false,
  protocols,
  reasons: {},
  models: [],
  capabilities,
});
// llama.cpp: only Chat Completions, so Claude Code and Codex use the Chat adapter.
const fresh = () => initialEndpoint(null, "llamacpp");

test("a re-test keeps fields the user changed and refreshes untouched ones", () => {
  let draft = applyProposal(
    fresh(),
    proposal({ chatCompletions: { reasoningEffort: false, systemMessages: "inline" } }),
  );
  draft = setCapability(draft, "chatCompletions", "reasoningEffort", true);
  assert.equal(capabilityOrigin(draft, "chatCompletions", "reasoningEffort"), "edited");
  assert.equal(capabilityOrigin(draft, "chatCompletions", "systemMessages"), "proposed");
  assert.equal(capabilityOrigin(draft, "chatCompletions", "streamUsage"), "default");
  draft = applyProposal(
    draft,
    proposal({ chatCompletions: { reasoningEffort: false, systemMessages: "merge" } }),
  );
  assert.deepEqual(draft.adapterCapabilities.chatCompletions, {
    reasoningEffort: true,
    systemMessages: "merge",
  });
  assert.equal(capabilityOrigin(draft, "chatCompletions", "reasoningEffort"), "edited");
  assert.equal(capabilityOrigin(draft, "chatCompletions", "systemMessages"), "proposed");
});

test("a re-test without edits takes every new proposal", () => {
  let draft = applyProposal(
    fresh(),
    proposal({ chatCompletions: { streamUsage: false } }),
  );
  draft = applyProposal(draft, proposal({ chatCompletions: { streamUsage: true } }));
  assert.deepEqual(draft.adapterCapabilities.chatCompletions, { streamUsage: true });
  assert.deepEqual(draft.capabilityEdits, {});
});

test("restoring defaults clears values, proposals and edits of one source", () => {
  let draft = applyProposal(
    fresh(),
    proposal({ chatCompletions: { streamUsage: false } }),
  );
  draft = setCapability(draft, "chatCompletions", "reasoningEffort", true);
  draft = resetCapabilities(draft, "chatCompletions");
  assert.deepEqual(draft.adapterCapabilities, {});
  assert.deepEqual(draft.capabilityProposal, {});
  assert.deepEqual(draft.capabilityEdits, {});
  assert.equal(capabilityOrigin(draft, "chatCompletions", "streamUsage"), "default");
  draft = applyProposal(draft, proposal({ chatCompletions: { reasoningEffort: false } }));
  assert.equal(draft.adapterCapabilities.chatCompletions.reasoningEffort, false);
});

test("proposals for protocols without an adapter route are not saved", () => {
  // Ollama: every protocol works, so all CLIs run natively and no adapter is used.
  const all = { messages: "ok", responses: "ok", chatCompletions: "ok" };
  const draft = applyProposal(
    initialEndpoint(null, "ollama"),
    proposal({ chatCompletions: { reasoningEffort: true } }, all),
  );
  assert.deepEqual(endpointPayload(draft).adapterCapabilities, {});
  assert.equal("capabilityEdits" in endpointPayload(draft), false);
  // Once a CLI routes through the Chat adapter, the shown proposal is saved.
  const routed = setRoute(draft, "claude", "adapter:chatCompletions");
  assert.deepEqual(endpointPayload(routed).adapterCapabilities, {
    chatCompletions: { reasoningEffort: true },
  });
  // A stale proposal for an unused protocol does not survive a new address.
  assert.deepEqual(withoutTest(draft).adapterCapabilities, {});
  assert.deepEqual(withoutTest(routed).adapterCapabilities, {
    chatCompletions: { reasoningEffort: true },
  });
});

test("stored values of an unused protocol survive a test that proposes nothing for them", () => {
  const stored = initialEndpoint({
    endpoint: {
      ...fresh(),
      routing: { claude: "native", codex: "native", opencode: "auto" },
      adapterCapabilities: { messages: { promptCache: false } },
    },
  });
  const all = { messages: "ok", responses: "ok", chatCompletions: "ok" };
  const draft = applyProposal(stored, proposal({}, all));
  assert.deepEqual(endpointPayload(draft).adapterCapabilities, {
    messages: { promptCache: false },
  });
  assert.equal(capabilityOrigin(draft, "messages", "promptCache"), "stored");
});

test("a proposal for an unused protocol never replaces its stored value", () => {
  const stored = initialEndpoint({
    endpoint: {
      ...fresh(),
      routing: { claude: "native", codex: "native", opencode: "auto" },
      adapterCapabilities: { messages: { promptCache: false, thinkingBudget: true } },
    },
  });
  const all = { messages: "ok", responses: "ok", chatCompletions: "ok" };
  let draft = applyProposal(
    stored,
    proposal({ messages: { promptCache: true, thinkingBudget: false } }, all),
  );
  draft = applyProposal(draft, proposal({ messages: { promptCache: true } }, all));
  const saved = { messages: { promptCache: false, thinkingBudget: true } };
  assert.deepEqual(endpointPayload(draft).adapterCapabilities, saved);
  assert.deepEqual(withoutTest(draft).adapterCapabilities, saved);
  // Routed through the Messages adapter, the shown proposal is saved instead.
  const routed = setRoute(draft, "codex", "adapter:messages");
  assert.deepEqual(endpointPayload(routed).adapterCapabilities, {
    messages: { promptCache: true, thinkingBudget: true },
  });
});

test("a test whose listing was refused keeps protocols it did not probe", () => {
  const draft = applyProposal(
    {
      ...fresh(),
      protocols: { messages: false, responses: true, chatCompletions: true },
    },
    {
      listed: false,
      listReason: "auth",
      protocols: { messages: "skipped", responses: "skipped", chatCompletions: "failed" },
      reasons: { messages: "auth", responses: "auth", chatCompletions: "auth" },
      models: [],
      capabilities: {},
    },
  );
  assert.deepEqual(draft.protocols, {
    messages: false,
    responses: true,
    chatCompletions: false,
  });
  assert.equal(draft.lastTest.reasons.responses, "auth");
});
