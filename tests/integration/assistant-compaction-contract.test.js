import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { MemoryFlushes } from "../../server/features/assistants/memory-flushes.js";
import { Compactions } from "../../server/features/assistants/compactions.js";
import { publicMessages } from "../../server/features/assistants/conversations.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

// Answers every turn near the context window, so the next one compacts first. It
// notes for each request whether it was the memory flush, the compaction's summary
// call or a turn, and whether AgentPier showed the session as summarising then.
async function compactingModel(seen, summarising) {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const all = JSON.stringify(body.messages);
    const kind = all.includes("Pre-compaction memory flush")
      ? "flush"
      : all.includes("context summarization assistant")
        ? "summary"
        : "turn";
    seen.push({ kind, summarising: summarising() });
    const content =
      kind === "flush"
        ? "NO_REPLY"
        : kind === "summary"
          ? "## Goal\nThe owner describes the network."
          : `Noted. ${"padding ".repeat(200)}`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of [
      { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 31000, completion_tokens: 50, total_tokens: 31050 },
      },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "compaction", object: "chat.completion.chunk", model: body.model, ...item })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

const packageRoot = process.env.AGENTPIER_ASSISTANT_MEMORY_RUNTIME;
test(
  "pinned runtime: a run that compacts its history reports it before it answers",
  { skip: !packageRoot, timeout: contractTimeout(180000) },
  async (t) => {
    const runtimeVersion = JSON.parse(
      fs.readFileSync(
        path.join(packageRoot, "app/node_modules/openclaw/package.json"),
        "utf8",
      ),
    ).version;
    const dataDir = fs.mkdtempSync(
      path.join(
        process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR || os.tmpdir(),
        "compaction-",
      ),
    );
    const store = new AssistantStore({ dataDir }),
      ledger = new RequestLedger(store.db),
      contexts = new Map();
    const seen = [];
    const model = await compactingModel(seen, () => current());
    let agent = store.createAssistant({
      name: "Flusher",
      instructions: "Owner instructions.",
      model: { connectionId: "fixture", modelId: "fixture-model" },
    });
    agent = store.updateAssistant(
      agent.id,
      { capabilities: { memory: true, reminders: false } },
      agent.revision,
    );
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeVersion,
        nodePath: path.join(packageRoot, "node/bin/node"),
        entryPath: path.join(packageRoot, "app/node_modules/openclaw/openclaw.mjs"),
        teamPlugin: provisionTeamPlugin({ paths: runtime.paths, runtimeVersion }),
      }),
    });
    // As AssistantService wires it: Gateway `agent` events report the flush phase.
    const memoryFlushes = new MemoryFlushes(),
      gatewayEvents = new GatewayEventHub();
    gatewayEvents.on("agent", (payload) => memoryFlushes.observe(payload));
    // As AssistantService wires it, and the frames themselves for the order.
    const compactions = new Compactions(),
      frames = [];
    let current = () => false;
    gatewayEvents.on("agent", (payload) => {
      compactions.observe(payload);
      if (["run_status", "compaction", "lifecycle"].includes(payload?.stream))
        frames.push({
          stream: payload.stream,
          phase: payload.data?.phase,
          runId: payload.runId,
          sessionKey: payload.sessionKey,
        });
    });
    const bridge = new TeamBridge({
      assistants: { store, ledger, runtime, memoryFlushes },
      generation: () => runtime.generation,
      teams: { store: { context: (id) => contexts.get(id) || { kind: "unknown" } } },
    });
    t.after(async () => {
      await runtime.close();
      await bridge.close();
      await model.close();
      store.close();
      if (!process.env.AGENTPIER_KEEP_CONTRACT_DIR)
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
    runtime.teamConfiguration = async (installed) => ({
      directory: installed.teamPlugin.directory,
      connection: { ...(await bridge.start()), guardReportMs: 1000 },
      hostMaxConcurrent: 4,
      native: { token: "compaction-fixture" },
      profiles: store.listAssistants(),
    });
    await runtime.start();
    gatewayEvents.bind(runtime.client);
    const config = new AssistantConfig({
      store,
      workspaces: runtime.paths.workspaces,
      client: runtime.client,
      teamReady: () => bridge.status().ready,
      models: {
        resolve: () => ({
          providerId: "fixture",
          modelRef: "fixture/fixture-model",
          provider: {
            baseUrl: model.url,
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [
              {
                id: "fixture-model",
                name: "Fixture",
                contextWindow: 32768,
                maxTokens: 4096,
              },
            ],
          },
          release() {},
        }),
      },
    });
    config.nativeReady = () => true;
    config.writeGuard = () => bridge.guardLive();
    for (let n = 0; n < 200 && !bridge.guardLive(); n++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.guardLive(), true, "the started Gateway reports its guard");
    await config.apply(agent.id);
    // Any transcript forces the flush, so the second owner turn runs one.
    await patchConfig(runtime.client, () => ({
      patch: {
        agents: {
          defaults: { compaction: { memoryFlush: { forceFlushTranscriptBytes: 1 } } },
        },
      },
    }));
    const created = await createGatewaySession(runtime.client, {
      agentId: agent.runtimeAgentId,
      label: "Compaction contract",
    });
    const chat = store.saveConversation({
      assistantId: agent.id,
      runtimeSessionKey: created.key,
    });
    current = () => compactions.active(created.key);
    async function turn(text, context) {
      const request = ledger.accept(chat.id, {
          clientRequestId: crypto.randomUUID(),
          text,
        }),
        attempt = ledger.recordAttempt(request.id);
      contexts.set(request.id, context);
      await config.apply(agent.id);
      const sent = await runtime.client.call("sessions.send", {
        key: created.key,
        message: text,
        idempotencyKey: attempt.id,
      });
      ledger.transition(attempt.id, "accepted", { runtimeRunId: sent.runId });
      const done = await runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 60000 },
        { timeoutMs: 65000 },
      );
      ledger.transition(attempt.id, "completed");
      return done;
    }
    await turn("My router lives at 10.0.0.1.", { kind: "owner" });
    const before = seen.length,
      firstFrames = frames.length;
    await turn("And the DNS server at 10.0.0.53.", { kind: "owner" });
    const second = seen.slice(before);
    // The run flushes memory, then summarises, then answers; AgentPier showed the
    // session as summarising for the first two only.
    assert.deepEqual(
      second.map((s) => s.kind),
      ["flush", "summary", "turn"],
      JSON.stringify(second),
    );
    assert.deepEqual(
      second.map((s) => s.summarising),
      [true, true, false],
      JSON.stringify(second),
    );
    assert.equal(compactions.active(created.key), false, "over once the run is");
    // The phases on the source session, in order: memory_flushing, preparing_context
    // (the flush ended, the summary call follows), preparing_workspace (the run).
    const phases = frames
      .slice(firstFrames)
      .filter((f) => f.stream === "run_status" && f.sessionKey === created.key)
      .map((f) => f.phase);
    const flushAt = phases.indexOf("memory_flushing");
    assert.ok(flushAt >= 0, JSON.stringify(phases));
    assert.deepEqual(
      phases.slice(flushAt, flushAt + 3),
      ["memory_flushing", "preparing_context", "preparing_workspace"],
      JSON.stringify(phases),
    );
    // The finished compaction is a marker in the history with its token counts.
    const history = await runtime.client.call("chat.history", {
      sessionKey: created.key,
      limit: 100,
    });
    const notes = publicMessages(history.messages, { compactions: true }).filter(
      (m) => m.event === "compaction",
    );
    assert.ok(notes.length >= 1, JSON.stringify(history.messages.map((m) => m.role)));
    assert.ok(
      notes.every((n) => n.tokensBefore > 0 && n.tokensAfter > 0),
      JSON.stringify(notes),
    );
  },
);
