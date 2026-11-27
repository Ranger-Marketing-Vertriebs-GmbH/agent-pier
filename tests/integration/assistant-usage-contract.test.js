import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { assertUsage } from "../helpers/runtime-port-usage-contract.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import { createOpenClawRuntime } from "../../server/features/assistants/runtimes/openclaw/openclaw-runtime.js";
import { dayKey } from "../../server/features/assistants/runtimes/openclaw/openclaw-usage.js";

// The pinned Gateway's usage report, as the port reads it (openclaw-usage.js): the
// tokens of a turn, a cost only where the model has a price, and the context size.
// Each call of the model reports 1,200 prompt tokens, 200 of them cached, and 300
// completion tokens; the model "billed" also names what the provider billed, as an
// OpenRouter answer does.
const price = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 };
const billed = 0.0123;

async function usageModelServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") return res.writeHead(404).end();
    let bytes = "";
    for await (const part of req) bytes += part;
    const input = JSON.parse(bytes);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null, usage = undefined) =>
      res.write(
        `data: ${JSON.stringify({
          id: "usage-contract",
          object: "chat.completion.chunk",
          model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
          ...(usage && { usage }),
        })}\n\n`,
      );
    emit({ content: "Fine." });
    emit({}, "stop", {
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 200 },
      ...(input.model === "billed" && { cost: billed }),
    });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// Reuse only immutable app/node binaries; every state path is freshly generated.
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
test(
  "pinned Gateway reports a turn's tokens, and a cost only for a model with a price",
  { skip: !installed, timeout: contractTimeout(240000) },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(installed, "app/node_modules/openclaw/package.json"),
          "utf8",
        ),
      ).version,
      runtimeManifest.version,
    );
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-usage-contract-"));
    const supervisor = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    const store = new AssistantStore({ dataDir });
    const server = await usageModelServer();
    t.after(async () => {
      try {
        await supervisor.close();
        store.close();
        await server.close();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    const connections = new ProviderConnections({ dataDir });
    const models = new AssistantModels({ connections });
    // The model entry's `cost`, as AssistantModels compiles an OpenRouter model's
    // catalog price (tests/unit/assistant-models.test.js); an endpoint has none.
    const resolve = models.resolve.bind(models);
    models.resolve = (input) => {
      const lease = resolve(input);
      if (input.modelId === "priced") lease.provider.models[0].cost = { ...price };
      return lease;
    };
    await supervisor.start();
    const config = new AssistantConfig({
      runtime: supervisor,
      models,
      store,
      workspaces: supervisor.paths.workspaces,
    });
    const connection = connections.create({
      providerId: "endpoint",
      name: "usage",
      endpoint: {
        preset: "custom",
        openaiBaseUrl: `${server.origin}/v1`,
        authHeader: null,
        protocols: { messages: false, responses: false, chatCompletions: true },
        models: ["plain", "priced", "billed"].map((modelId) => ({
          modelId,
          source: "manual",
          contextTokens: 32768,
          outputTokens: 4096,
        })),
      },
    });
    const runtime = createOpenClawRuntime(supervisor);
    const now = Date.now();
    const turn = async (modelId) => {
      const agent = store.createAssistant({
        name: modelId,
        instructions: "Reply briefly.",
        model: { connectionId: connection.id, modelId },
      });
      await config.apply(agent.id);
      const { key } = await runtime.sessions.create({
        agentId: agent.runtimeAgentId,
        label: "usage",
      });
      // Nothing was used yet: no tokens, no price, no context.
      const before = await runtime.sessions.usage({ key });
      assertUsage(before, `${modelId} before`);
      assert.equal(before.tokens.total, 0, JSON.stringify(before));
      assert.equal(before.cost, null);
      assert.equal(before.context, null);
      // The read AgentPier makes when the run's end arrives as a run event
      // (gateway-wiring.js onUsageChange): started inside the listener itself.
      await runtime.sessions.subscribeMessages({ key });
      let atEnd = null;
      const unsubscribe = runtime.events.subscribe((event) => {
        if (event.kind === "finished" && event.sessionKey === key)
          atEnd ??= runtime.sessions.usage({ key });
      });
      t.after(unsubscribe);
      const { runId } = await runtime.sessions.send({
        key,
        turn: { message: "Hello?" },
        idempotencyKey: crypto.randomUUID(),
      });
      const result = await runtime.sessions.wait({
        runId,
        waitMs: 45000,
        timeoutMs: 50000,
      });
      assert.equal(result.status, "ok", JSON.stringify(result));
      // The adapter waits out the report OpenClaw still computes after a turn.
      const chat = await runtime.sessions.usage({ key });
      for (let i = 0; i < 100 && !atEnd; i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(atEnd, "the run's end arrived as a run event");
      assert.deepEqual(await atEnd, chat, "the read at the run's end is complete");
      const agentUsage = await runtime.agents.usage({
        agentId: agent.runtimeAgentId,
        days: 7,
        now,
      });
      t.diagnostic(JSON.stringify({ modelId, chat, agentUsage }));
      return { chat, agentUsage };
    };
    const tokens = {
      input: 1000,
      output: 300,
      cacheRead: 200,
      cacheWrite: 0,
      total: 1500,
    };

    // A model without a price: the tokens, never a cost.
    const plain = await turn("plain");
    assertUsage(plain.chat, "plain");
    assert.deepEqual(plain.chat.tokens, tokens);
    assert.equal(plain.chat.cost, null);
    assert.equal(plain.chat.pending, false);
    // The context is the prompt of its last call, of the model's window.
    assert.deepEqual(plain.chat.context, { used: 1200, limit: 32768 });
    assert.deepEqual(plain.agentUsage.tokens, tokens);
    assert.equal(plain.agentUsage.cost, null);
    assert.equal(plain.agentUsage.to, dayKey(new Date(now)));
    assert.equal(plain.agentUsage.daily.length, 7);
    assert.deepEqual(plain.agentUsage.daily.at(-1), {
      date: dayKey(new Date(now)),
      tokens: 1500,
    });
    assert.equal(
      plain.agentUsage.daily.slice(0, -1).some((day) => day.tokens > 0),
      false,
    );

    // A model entry with `cost` (USD per 1M tokens): OpenClaw's estimate.
    const priced = await turn("priced");
    const estimate =
      (1000 * price.input + 300 * price.output + 200 * price.cacheRead) / 1e6;
    assert.deepEqual(priced.chat.tokens, tokens);
    assert.deepEqual(priced.chat.cost, {
      amount: estimate,
      currency: "USD",
      partial: false,
    });
    assert.deepEqual(priced.agentUsage.cost, priced.chat.cost);

    // An answer that names what the provider billed: that amount, without a price.
    const paid = await turn("billed");
    assert.deepEqual(paid.chat.cost, { amount: billed, currency: "USD", partial: false });
    assert.deepEqual(paid.agentUsage.cost, paid.chat.cost);
  },
);
