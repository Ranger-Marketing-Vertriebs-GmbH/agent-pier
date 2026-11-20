import test from "node:test";
import assert from "node:assert/strict";
import { contractTimeout } from "../helpers/contract-timeout.js";
import {
  AZURE_TOOLS_REFUSAL,
  azureReasoningServer,
} from "../helpers/azure-reasoning-server.js";
import {
  collectEvents,
  endsRun,
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";
import { runFailure } from "../../server/features/assistants/routine-failures.js";

// A Hermes agent on an Azure OpenAI reasoning deployment (AGENTPIER-439) on the pinned
// Hermes as AgentPier runs it (AGENTPIER_HERMES_CONTRACT_RUNTIME). Azure refuses
// function tools together with `reasoning_effort` on Chat Completions and points to
// Responses; Hermes reaches a named provider over Responses (`api_mode:
// codex_responses`), so a keyed connection that offers Responses runs there, as on
// OpenClaw (assistant-provider-responses-contract.test.js). A turn the provider
// refuses ends with the provider's own reason. The server is the in-repo fake.
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-azure";
const KEY = "azure-contract-key";
const DEPLOYMENT = "gpt-6.2-sol";

// An Azure OpenAI v1 connection (assistant-provider-endpoint.js): its key in the
// `api-key` header, on Responses when it offers them, else on Chat Completions.
const azure = (origin, api) => ({
  baseUrl: `${origin}/openai/v1`,
  provider: {
    api,
    apiKey: KEY,
    authHeader: false,
    headers: { authorization: "", "api-key": KEY },
    models: [
      { id: DEPLOYMENT, name: DEPLOYMENT, contextWindow: 1000000, maxTokens: 4096 },
    ],
  },
});

async function azureAgent(t, api) {
  // Hermes calls the tool the fake asks for: the agent's own memory tool.
  const server = await azureReasoningServer({
    apiKey: KEY,
    deployment: DEPLOYMENT,
    tool: "memory",
  });
  t.after(() => server.close());
  const dirs = hermesSandbox(t);
  const hermes = await startHermes(t, dirs, {
    agentId,
    model: azure(server.origin, api),
    // A thinking level, so Hermes sends `reasoning_effort` with the tools.
    advanced: { thinkingDefault: "high" },
  });
  const seen = collectEvents(hermes.events);
  t.after(() => seen.unsubscribe());
  const { key } = await hermes.sessions.create({ agentId, label: "Azure chat" });
  return { server, dirs, hermes, seen, key };
}

test(
  "Hermes contract: an Azure connection that offers Responses runs tool turns there",
  options,
  async (t) => {
    const { server, dirs, hermes, seen, key } = await azureAgent(t, "openai-responses");
    await hermes.sessions.send({
      key,
      turn: { message: "Look at your memory." },
      idempotencyKey: "az-1",
    });
    const end = await seen.until(endsRun("az-1"), 180000);
    assert.equal(end.kind, "finished", JSON.stringify(end.payload));
    const turns = server.requests.filter((r) => r.input?.model === DEPLOYMENT);
    assert.ok(turns.length >= 2, "a tool call and the answer after it");
    for (const request of turns) {
      assert.equal(request.url, "/openai/v1/responses");
      assert.equal(request.headers["api-key"], KEY);
      assert.doesNotMatch(String(request.headers.authorization ?? ""), /azure-contract/);
    }
    assert.ok(
      turns.some((r) => r.input.input?.some((i) => i.type === "function_call_output")),
      "the tool's result went back on Responses",
    );
    assert.match(end.payload.text ?? "", /Azure contract complete\./);
    await hermes.stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);

test(
  "Hermes contract: a turn the provider refuses ends with the provider's reason",
  options,
  async (t) => {
    const { server, hermes, seen, key } = await azureAgent(t, "openai-completions");
    await hermes.sessions.send({
      key,
      turn: { message: "Look at your memory." },
      idempotencyKey: "az-2",
    });
    const end = await seen.until(endsRun("az-2"), 180000);
    assert.equal(end.kind, "failed");
    assert.ok(server.requests.some((r) => r.url === "/openai/v1/chat/completions"));
    const outcome = await hermes.sessions.wait({ runId: "az-2", waitMs: 1000 });
    assert.equal(outcome.status, "error");
    assert.match(outcome.error, /Function tools with reasoning_effort are not supported/);
    // The chat names the provider as the cause and shows its text
    // (run-reconciler.js providerFailure).
    const failure = runFailure(outcome);
    assert.equal(failure.reason, "model");
    assert.ok(failure.message.includes(AZURE_TOOLS_REFUSAL.slice(0, 60)));
    assert.doesNotMatch(failure.message, new RegExp(KEY));
    await hermes.stop();
  },
);
