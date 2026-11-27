import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import { shellGateway } from "../helpers/assistant-shell-gateway.js";
import { patchConfig } from "../../server/features/assistants/runtimes/openclaw/live-patch.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";
import { thinkingLevels } from "../../server/features/assistants/runtimes/openclaw/openclaw-options.js";

// What the pinned Gateway does with an agent's own thinking level and fast mode
// (`agents.entries.<id>.thinkingDefault` and `.fastModeDefault`, which AgentPier
// compiles from runtimeOptions.openclaw, openclaw-config/agent-entry.js).
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};

test(
  "an agent's thinking level and fast mode apply live, and an unsupported level is clamped",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "model-options-contract-" });
    gw.tool.name = "none";
    const model = (id, extra) => ({
      id,
      name: id,
      contextWindow: 32768,
      maxTokens: 4096,
      ...extra,
    });
    await gw.configure({
      models: {
        providers: {
          thinker: {
            baseUrl: gw.model.url,
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [model("reasons", { reasoning: true }), model("plain")],
          },
        },
      },
      tools: { allow: ["session_status"] },
    });
    const pid = gw.runtime.child.pid;
    const entry = async (patch) => {
      await patchConfig(gw.client, () => ({
        patch: { agents: { entries: { main: patch } } },
      }));
      const { config } = await gw.client.call("config.get", {});
      return config.agents.entries.main;
    };
    const turn = async (label) => {
      const run = await gw.send(label, "true");
      await gw.settle(run);
      return gw.model.requests.slice(run.from).at(-1);
    };
    await entry({ model: "thinker/reasons" });
    // Unset, a reasoning model of a custom endpoint thinks at OpenClaw's fallback.
    assert.equal((await turn("unset")).reasoning_effort, "medium");
    // Every level of the enum is accepted for every model. The next turn uses it; a
    // level this model does not declare is clamped to one it has, and "off" sends no
    // effort at all (a custom endpoint may not accept "none").
    const sent = {};
    for (const level of thinkingLevels) {
      const written = await entry({ thinkingDefault: level, fastModeDefault: true });
      assert.equal(written.thinkingDefault, level);
      assert.equal(written.fastModeDefault, true);
      const request = await turn(`level-${level}`);
      sent[level] = request.reasoning_effort;
      // Fast mode is a provider feature; a custom endpoint gets no tier.
      assert.equal(request.service_tier, undefined, level);
    }
    t.diagnostic(`efforts=${JSON.stringify(sent)}`);
    assert.deepEqual(sent, {
      off: undefined,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      adaptive: "medium",
      max: "high",
      ultra: "high",
    });
    // A chat that already ran follows a later change: no level sticks to a session.
    const session = await createGatewaySession(gw.client, { agentId: "main" });
    const again = async (idempotencyKey) => {
      const from = gw.model.requests.length;
      const { runId } = await gw.client.call("sessions.send", {
        key: session.key,
        message: "Again.",
        idempotencyKey,
      });
      await gw.settle({ runId, from });
      return gw.model.requests.slice(from).at(-1).reasoning_effort;
    };
    await entry({ thinkingDefault: "low" });
    assert.equal(await again("same-chat-low"), "low");
    await entry({ thinkingDefault: "high" });
    assert.equal(await again("same-chat-high"), "high");
    // null removes a key (a merge patch keeps an omitted one): the fallback is back.
    const removed = await entry({ thinkingDefault: null, fastModeDefault: null });
    assert.equal("thinkingDefault" in removed, false);
    assert.equal("fastModeDefault" in removed, false);
    assert.equal(await again("same-chat-unset"), "medium");
    // A model without thinking ignores any level instead of failing the turn.
    await entry({
      model: "thinker/plain",
      thinkingDefault: "max",
      fastModeDefault: false,
    });
    assert.equal((await turn("plain")).reasoning_effort, undefined);
    // All of it without a Gateway restart.
    assert.equal(gw.runtime.child.pid, pid);
  },
);
