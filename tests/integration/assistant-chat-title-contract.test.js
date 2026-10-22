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
import { chatTitleMethod } from "../../server/features/assistants/team-plugin/chat-title.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

// AGENTPIER-187 on the pinned Gateway: the product plugin's title method runs one
// tool-less prompt on the asking agent's own model and leaves nothing in its
// sessions. The model is a scripted OpenAI-compatible server.
const packageRoot = process.env.AGENTPIER_TEAM_CONTRACT_RUNTIME;
test(
  "pinned runtime names a chat on the agent's model without a session",
  { skip: !packageRoot, timeout: contractTimeout(240000) },
  async (t) => {
    assert.ok(path.isAbsolute(packageRoot));
    const runtimeVersion = JSON.parse(
      fs.readFileSync(
        path.join(packageRoot, "app/node_modules/openclaw/package.json"),
        "utf8",
      ),
    ).version;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-title-contract-"));
    const store = new AssistantStore({ dataDir }),
      ledger = new RequestLedger(store.db);
    // Two agents on two models: the title must come from the one that asks.
    const agents = ["first", "second"].map((name) =>
      store.createAssistant({
        name,
        instructions: "Answer briefly.",
        model: { connectionId: name, modelId: `${name}-model` },
      }),
    );
    const requests = [];
    const model = http.createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      const titling = JSON.stringify(body.messages).includes("You name chats");
      const content = titling ? `"Trip to Lisbon." (${body.model})` : "Alfama is lovely.";
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const item of [
        { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ])
        res.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model, ...item })}\n\n`,
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
    const bridge = new TeamBridge({
      assistants: { store, ledger, runtime },
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
      hostMaxConcurrent: 8,
    });
    await runtime.start();
    const config = new AssistantConfig({
      store,
      workspaces: runtime.paths.workspaces,
      client: runtime.client,
      teamReady: () => bridge.status().ready,
      models: {
        resolve: ({ connectionId, modelId }) => ({
          providerId: connectionId,
          modelRef: `${connectionId}/${modelId}`,
          provider: {
            baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [
              { id: modelId, name: modelId, contextWindow: 32768, maxTokens: 4096 },
            ],
          },
          release() {},
        }),
      },
    });
    for (const agent of agents) await config.apply(agent.id);
    const created = await createGatewaySession(runtime.client, {
      agentId: agents[1].runtimeAgentId,
      label: "Contract chat",
    });
    const sent = await runtime.client.call("sessions.send", {
      key: created.key,
      message: "Plan the trip to Lisbon",
      idempotencyKey: crypto.randomUUID(),
    });
    const done = await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 45000 },
      { timeoutMs: 50000 },
    );
    assert.equal(done.status, "ok");
    const sessions = await runtime.client.call("sessions.list", {});
    const history = await runtime.client.call("chat.history", {
      sessionKey: created.key,
      limit: 100,
    });
    const before = requests.length;
    const result = await runtime.client.call(
      chatTitleMethod,
      {
        agentId: agents[1].runtimeAgentId,
        message: "Plan the trip to Lisbon",
        reply: "Alfama is lovely.",
      },
      { timeoutMs: 40000 },
    );
    assert.equal(result.title, '"Trip to Lisbon." (second-model)');
    // One request to the asking agent's model: two messages, no tools.
    const asked = requests.slice(before);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].model, "second-model");
    assert.deepEqual(
      asked[0].messages.map((m) => m.role),
      ["system", "user"],
    );
    assert.ok(!asked[0].tools?.length, "no tools");
    assert.match(JSON.stringify(asked[0].messages[1]), /<message>.*Plan the trip/);
    // Nothing joined the chat or the session list.
    assert.deepEqual(
      (await runtime.client.call("sessions.list", {})).sessions.map((s) => s.key).sort(),
      sessions.sessions.map((s) => s.key).sort(),
    );
    assert.equal(
      (await runtime.client.call("chat.history", { sessionKey: created.key, limit: 100 }))
        .messages.length,
      history.messages.length,
    );
    // Malformed requests are refused before any model call.
    await assert.rejects(
      runtime.client.call(chatTitleMethod, { agentId: agents[1].runtimeAgentId }),
      { code: "INVALID_REQUEST" },
    );
    assert.equal(requests.length, before + 1);
  },
);
