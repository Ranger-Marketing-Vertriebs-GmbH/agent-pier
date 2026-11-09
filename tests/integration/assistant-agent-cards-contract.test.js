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
import { AgentShares } from "../../server/features/assistants/agent-shares.js";
import { AgentCards } from "../../server/features/assistants/agent-cards.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";

// Agent cards on the pinned Gateway (AGENTPIER_TEAM_CONTRACT_RUNTIME): OpenClaw offers
// the installed plugin's agentpier_card with its schema, the model's call reaches
// AgentCards through the attempt-bound bridge, and the card lands in the turn's chat.
const packageRoot = process.env.AGENTPIER_TEAM_CONTRACT_RUNTIME;
const card = {
  action: "create",
  title: "Infrastructure status",
  blocks: [
    { type: "metrics", items: [{ label: "Hosts ok", value: "11", tone: "ok" }] },
    { type: "status", items: [{ label: "mimir", state: "warn", detail: "Link down" }] },
    {
      type: "chart",
      kind: "line",
      unit: "%",
      points: [
        { label: "00:00", value: 20 },
        { label: "12:00", value: 45 },
      ],
    },
    {
      type: "table",
      columns: ["Host", "Load"],
      rows: [{ cells: ["proxmox-1", "45 %"], action: { label: "Check" } }],
    },
    { type: "checklist", items: [{ id: "a", text: "Reboot mimir" }] },
    { type: "actions", items: [{ label: "Check again", primary: true }] },
  ],
};

test(
  "pinned Gateway: an agent shows a card in its chat with agentpier_card",
  { skip: !packageRoot, timeout: contractTimeout(240000) },
  async (t) => {
    assert.ok(path.isAbsolute(packageRoot));
    const runtimeVersion = JSON.parse(
      fs.readFileSync(
        path.join(packageRoot, "app/node_modules/openclaw/package.json"),
        "utf8",
      ),
    ).version;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-cards-contract-"));
    const store = new AssistantStore({ dataDir }),
      ledger = new RequestLedger(store.db);
    const agent = store.createAssistant({
      name: "Network Architect",
      instructions: "Show cards.",
      model: { connectionId: "fixture", modelId: "fixture-model" },
    });
    const requests = [];
    const model = http.createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      const tool = !body.messages.some((m) => m.role === "tool");
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: "card-call",
                type: "function",
                function: { name: "agentpier_card", arguments: JSON.stringify(card) },
              },
            ],
          }
        : { content: "Here is the board." };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const item of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      ])
        res.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", ...item })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    });
    await new Promise((r) => model.listen(0, "127.0.0.1", r));
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeVersion,
        nodePath: path.join(packageRoot, "node/bin/node"),
        entryPath: path.join(packageRoot, "app/node_modules/openclaw/openclaw.mjs"),
        teamPlugin: provisionTeamPlugin({ paths: runtime.paths, runtimeVersion }),
      }),
    });
    const assistants = { store, ledger, runtime, changed() {} };
    assistants.shares = new AgentShares({ assistants });
    assistants.cards = new AgentCards({ assistants });
    const bridge = new TeamBridge({
      assistants,
      generation: () => runtime.generation,
      teams: {},
    });
    t.after(async () => {
      await runtime.close();
      await bridge.close();
      await new Promise((r) => {
        model.closeAllConnections();
        model.close(r);
      });
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    runtime.teamConfiguration = async (installed) => ({
      directory: installed.teamPlugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "cards-fixture" },
    });
    await runtime.start();
    const config = new AssistantConfig({
      store,
      workspaces: runtime.paths.workspaces,
      runtime,
      teamReady: () => bridge.status().ready,
      nativeReady: () => true,
      models: {
        resolve: () => ({
          providerId: "fixture",
          modelRef: "fixture/fixture-model",
          provider: {
            baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
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
    await config.apply(agent.id);
    const created = await createGatewaySession(runtime.client, {
      agentId: agent.runtimeAgentId,
      label: "Cards contract",
    });
    const chat = store.saveConversation({
      assistantId: agent.id,
      runtimeSessionKey: created.key,
    });
    const request = ledger.accept(chat.id, {
        clientRequestId: "cards",
        text: "How are the hosts?",
      }),
      attempt = ledger.recordAttempt(request.id);
    const sent = await runtime.client.call("sessions.send", {
      key: created.key,
      message: request.text,
      idempotencyKey: attempt.id,
    });
    ledger.transition(attempt.id, "accepted", { runtimeRunId: sent.runId });
    const done = await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    assert.equal(done.status, "ok");
    const offered = requests[0].tools.find((t) => t.function.name === "agentpier_card");
    assert.ok(offered, "OpenClaw offers agentpier_card");
    assert.deepEqual(offered.function.parameters.properties.action.enum, [
      "create",
      "update",
      "read",
    ]);
    assert.ok(done.terminalReceipt.successfulToolNames.includes("agentpier_card"));
    const [stored] = assistants.cards.store.forConversation(chat.id);
    assert.equal(stored.title, "Infrastructure status");
    assert.equal(stored.placements[0].requestId, request.id);
    assert.equal(stored.blocks.length, 6);
    const result = JSON.stringify(
      requests.at(-1).messages.filter((m) => m.role === "tool"),
    );
    assert.match(result, /\\"status\\": ?\\"created\\"/);
  },
);
