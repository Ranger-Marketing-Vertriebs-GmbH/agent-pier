import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { MemoryFlushes } from "../../server/features/assistants/memory-flushes.js";

// Answers owner turns with text; a pre-compaction memory flush appends one note to
// the daily file the flush prompt names, then stays silent.
async function flushingModel(seen) {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const all = JSON.stringify(body.messages);
    const flush = all.includes("Pre-compaction memory flush");
    const [, target] = all.match(/(memory\/\d{4}-\d{2}-\d{2}\.md)/) || [];
    const answered =
      body.messages.findLastIndex((m) => m.role === "tool") >
      body.messages.findLastIndex((m) => m.role === "user");
    if (flush) seen.push({ target, answered });
    const delta =
      flush && target && !answered
        ? {
            tool_calls: [
              {
                index: 0,
                id: "flush-write",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ path: target, content: "flushfact\n" }),
                },
              },
            ],
          }
        : { content: flush ? "NO_REPLY" : `Noted. ${"padding ".repeat(200)}` };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      {
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: delta.tool_calls ? "tool_calls" : "stop",
          },
        ],
        // A conversation close to the context window: the next turn compacts first.
        usage: { prompt_tokens: 31000, completion_tokens: 50, total_tokens: 31050 },
      },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "flush", object: "chat.completion.chunk", model: body.model, ...item })}\n\n`,
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
  "pinned runtime: the pre-compaction memory flush of an owner turn reaches the daily note",
  { skip: !packageRoot, timeout: 180000 },
  async (t) => {
    const runtimeVersion = JSON.parse(
      fs.readFileSync(
        path.join(packageRoot, "app/node_modules/openclaw/package.json"),
        "utf8",
      ),
    ).version;
    const dataDir = fs.mkdtempSync(
      path.join(process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR || os.tmpdir(), "flush-"),
    );
    const store = new AssistantStore({ dataDir }),
      ledger = new RequestLedger(store.db),
      contexts = new Map();
    const seen = [];
    const model = await flushingModel(seen);
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
    const policies = [];
    const original = bridge.toolPolicy.bind(bridge);
    bridge.toolPolicy = (input) => {
      const result = original(input);
      policies.push({ ...input, ...result });
      return result;
    };
    runtime.teamConfiguration = async (installed) => ({
      directory: installed.teamPlugin.directory,
      connection: { ...(await bridge.start()), guardReportMs: 1000 },
      hostMaxConcurrent: 4,
      native: { token: "flush-fixture" },
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
    const workspace = path.join(runtime.paths.workspaces, agent.id);
    const created = await runtime.client.call("sessions.create", {
      agentId: agent.runtimeAgentId,
      label: "Flush contract",
    });
    const chat = store.saveConversation({
      assistantId: agent.id,
      runtimeSessionKey: created.key,
    });
    const daily = () => {
      const memory = path.join(workspace, "memory");
      const name = fs.existsSync(memory)
        ? fs.readdirSync(memory).find((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        : null;
      return name ? fs.readFileSync(path.join(memory, name), "utf8") : null;
    };
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
    // A forwarded turn near the context window flushes too, but never writes.
    await turn("Forwarded: the router lives at 10.6.6.6.", {
      kind: "telegram",
      forwarded: true,
    });
    await turn("Forwarded: and the DNS at 10.6.6.53.", {
      kind: "telegram",
      forwarded: true,
    });
    assert.ok(seen.length >= 1, "the Gateway ran a memory flush");
    assert.ok(
      seen.every((s) => s.target),
      "the flush names its daily note",
    );
    const denied = policies.filter((p) =>
      p.sessionKey.includes(":internal-session-effects:"),
    );
    assert.ok(denied.length >= 1, "the flush's write reached the guard");
    assert.ok(
      denied.every((p) => p.allow === false),
      "a forwarded run's flush is refused",
    );
    assert.equal(daily() || "", "", "nothing was written for the forwarded run");
    // The owner's own turns: the next compaction's flush appends the note.
    const flushes = seen.length;
    await turn("My router lives at 10.0.0.1.", { kind: "owner" });
    await turn("And the DNS server at 10.0.0.53.", { kind: "owner" });
    assert.ok(seen.length > flushes, "the owner's run flushed");
    const admitted = policies.filter(
      (p) => p.sessionKey.includes(":internal-session-effects:") && p.allow,
    );
    assert.ok(admitted.length >= 1, JSON.stringify(policies));
    assert.ok(
      admitted.every(
        (p) => p.toolName === "write" && /^memory\/[\d-]+\.md$/.test(p.path),
      ),
    );
    assert.match(daily(), /flushfact/, "the daily note got the flush's content");
    assert.equal(fs.existsSync(path.join(workspace, "MEMORY.md")), false);
  },
);
