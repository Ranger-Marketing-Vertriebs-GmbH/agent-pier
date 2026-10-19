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
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { teamTools } from "../../server/features/assistants/runtime-config.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";

test("plugin guard rejects a prepare response after native invocation retirement", async (t) => {
  let live = true,
    calls = 0;
  const factories = [];
  plugin.register({
    pluginConfig: { url: "http://unused", token: "test" },
    registerTool: (f) => factories.push(f),
    on() {},
  });
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    live = false;
    return { ok: true, json: async () => ({ ticket: "stale" }) };
  });
  const tool = factories[0].create({
    agentId: "parent",
    sessionKey: "session",
    assertInvocationCurrent() {
      if (!live) throw Error("retired");
    },
  });
  await assert.rejects(tool.execute("call", {}), /retired/);
  assert.equal(calls, 1, "retired invocation never invokes the bridge");
});

const packageRoot = process.env.AGENTPIER_TEAM_CONTRACT_RUNTIME;
test(
  "pinned runtime executes the installed product plugin through the attempt-bound bridge",
  { skip: !packageRoot, timeout: contractTimeout(330000) },
  async (t) => {
    assert.ok(path.isAbsolute(packageRoot));
    const runtimeVersion = JSON.parse(
      fs.readFileSync(
        path.join(packageRoot, "app/node_modules/openclaw/package.json"),
        "utf8",
      ),
    ).version;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-team-contract-"));
    const store = new AssistantStore({ dataDir }),
      ledger = new RequestLedger(store.db),
      teams = new TeamStore({ store });
    const parent = store.createAssistant({
      name: "Parent",
      instructions: "Use the team tool.",
      model: { connectionId: "fixture", modelId: "fixture-model" },
    });
    const requests = [];
    const asks = [],
      // The full wait budget (lead-requests.js askWaitMs is 110 s) outside pull
      // requests; 12 s, beyond the ordinary 10 s bridge budget, otherwise.
      askDelayMs = process.env.AGENTPIER_TEAM_LONG_ASK === "1" ? 115000 : 12000;
    const model = http.createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      const tool = !body.messages.some((m) => m.role === "tool");
      const bypass = JSON.stringify(body.messages).includes("TRY_NATIVE_SPAWN");
      const asking = JSON.stringify(body.messages).includes("ASK_MEMBER");
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: asking ? "ask-call" : "proposal-call",
                type: "function",
                function: asking
                  ? {
                      name: "agentpier_team_ask",
                      arguments: JSON.stringify({
                        memberId: "member-fixture",
                        question: "What is the budget?",
                      }),
                    }
                  : {
                      name: bypass ? "sessions_spawn" : "agentpier_team_propose",
                      arguments: JSON.stringify({
                        objective: "Review",
                        members: [
                          {
                            name: "Reviewer",
                            role: "Review",
                            assignment: "Review tests",
                          },
                        ],
                      }),
                    },
              },
            ],
          }
        : { content: asking ? "Answer relayed." : "Proposal received." };
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
        teamPlugin: provisionTeamPlugin({
          paths: runtime.paths,
          runtimeVersion,
        }),
      }),
    });
    const bridge = new TeamBridge({
      assistants: { store, ledger, runtime },
      generation: () => runtime.generation,
      teams: {
        // Holds the call longer than any other bridge call may take: an ask waits
        // for the member's answer (lead-requests.js askWaitMs).
        async ask(inv, input) {
          inv.assertCurrent();
          asks.push({ attemptId: inv.attemptId, input });
          await new Promise((r) => setTimeout(r, askDelayMs));
          inv.assertCurrent();
          return { status: "answered", answer: "The budget is five thousand." };
        },
        propose(inv, input) {
          inv.assertCurrent();
          return teams.propose({
            ...input,
            operationId: inv.toolCallId,
            parentAttemptId: inv.attemptId,
          });
        },
      },
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
      hostMaxConcurrent: 8,
    });
    await runtime.start();
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
    await config.apply(parent.id);
    const created = await runtime.client.call("sessions.create", {
      agentId: parent.runtimeAgentId,
      label: "Contract parent",
    });
    const chat = store.saveConversation({
      assistantId: parent.id,
      runtimeSessionKey: created.key,
    });
    const request = ledger.accept(chat.id, {
        clientRequestId: "contract",
        text: "Propose a team",
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
      { runId: sent.runId, timeoutMs: 45000 },
      { timeoutMs: 50000 },
    );
    assert.equal(done.status, "ok");
    assert.ok(
      done.terminalReceipt.successfulToolNames.includes("agentpier_team_propose"),
    );
    assert.equal(teams.list().length, 1);
    assert.equal(teams.list()[0].parentAttemptId, attempt.id);
    assert.equal(teams.list()[0].phase, "awaiting_approval");
    assert.deepEqual(
      requests[0].tools.map((t) => t.function.name).sort(),
      [...teamTools].sort(),
    );
    // A model-emitted alternate delegation name must not gain capabilities.
    const tools = requests[0].tools.map((t) => t.function.name);
    assert.ok(
      !tools.some((n) =>
        ["sessions_spawn", "sessions_send", "gateway", "exec"].includes(n),
      ),
    );
    const bypassChat = await runtime.client.call("sessions.create", {
      agentId: parent.runtimeAgentId,
      label: "Denied native spawn",
    });
    const beforeBypass = await runtime.client.call("sessions.list", {});
    const bypassSend = await runtime.client.call("sessions.send", {
      key: bypassChat.key,
      message: "TRY_NATIVE_SPAWN",
      idempotencyKey: crypto.randomUUID(),
    });
    const bypassDone = await runtime.client.call(
      "agent.wait",
      { runId: bypassSend.runId, timeoutMs: 30000 },
      { timeoutMs: 35000 },
    );
    assert.ok(
      !bypassDone.terminalReceipt?.successfulToolNames?.includes("sessions_spawn"),
    );
    const afterBypass = await runtime.client.call("sessions.list", {});
    assert.equal(
      afterBypass.sessions.length,
      beforeBypass.sessions.length,
      "a model-emitted native spawn cannot create a child",
    );
    // A lead's ask blocks its tool call beyond the ordinary 10-second bridge budget
    // and its answer reaches the model as the tool result.
    const askChat = await runtime.client.call("sessions.create", {
      agentId: parent.runtimeAgentId,
      label: "Contract ask",
    });
    const askConversation = store.saveConversation({
      assistantId: parent.id,
      runtimeSessionKey: askChat.key,
    });
    const askRequest = ledger.accept(askConversation.id, {
        clientRequestId: "contract-ask",
        text: "ASK_MEMBER about the budget",
      }),
      askAttempt = ledger.recordAttempt(askRequest.id);
    const before = requests.length;
    const askSend = await runtime.client.call("sessions.send", {
      key: askChat.key,
      message: askRequest.text,
      idempotencyKey: askAttempt.id,
    });
    ledger.transition(askAttempt.id, "accepted", { runtimeRunId: askSend.runId });
    const asked = await runtime.client.call(
      "agent.wait",
      { runId: askSend.runId, timeoutMs: askDelayMs + 48000 },
      { timeoutMs: askDelayMs + 53000 },
    );
    assert.equal(asked.status, "ok");
    assert.ok(asked.terminalReceipt.successfulToolNames.includes("agentpier_team_ask"));
    assert.deepEqual(asks, [
      {
        attemptId: askAttempt.id,
        input: { memberId: "member-fixture", question: "What is the budget?" },
      },
    ]);
    const toolTurn = requests
      .slice(before)
      .find((r) => r.messages.some((m) => m.role === "tool"));
    assert.match(
      JSON.stringify(toolTurn.messages.filter((m) => m.role === "tool")),
      /The budget is five thousand/,
    );
    ledger.transition(askAttempt.id, "completed");
    await bridge.close();
    const another = await runtime.client.call("sessions.create", {
      agentId: parent.runtimeAgentId,
      label: "Unavailable bridge",
    });
    const second = await runtime.client.call("sessions.send", {
      key: another.key,
      message: "Propose another team",
      idempotencyKey: crypto.randomUUID(),
    });
    await runtime.client.call(
      "agent.wait",
      { runId: second.runId, timeoutMs: 30000 },
      { timeoutMs: 35000 },
    );
    assert.equal(teams.list().length, 1, "unavailable bridge cannot admit work");
  },
);
