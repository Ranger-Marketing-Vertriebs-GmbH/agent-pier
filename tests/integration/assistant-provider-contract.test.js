import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { assistantProviderServer } from "../helpers/assistant-provider-server.js";

// Reuse only immutable app/node binaries. Every state, account and config path is
// freshly generated; this test never opens an installed runtime's user data.
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
test(
  "pinned Gateway streams central endpoint tool loops with exact authentication",
  {
    skip: !installed,
    timeout: 240000,
  },
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
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "assistant-provider-contract-"),
    );
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    const store = new AssistantStore({ dataDir });
    const server = await assistantProviderServer();
    t.after(async () => {
      try {
        await runtime.close();
        store.close();
        await server.close();
        for (const name of ["gateway-console.log", "openclaw.log"]) {
          const file = path.join(runtime.paths.logs, name);
          const output = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
          for (const key of [
            "fixture-bearer-only",
            "fixture-custom-only",
            "fixture-rotated-only",
            "fixture-azure-only",
          ])
            assert.equal(
              output.includes(key),
              false,
              "provider credentials stay out of runtime logs",
            );
        }
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    const connections = new ProviderConnections({ dataDir });
    const models = new AssistantModels({ connections });
    await runtime.start();
    const config = new AssistantConfig({
      client: runtime.client,
      models,
      store,
      workspaces: runtime.paths.workspaces,
    });
    let previous;
    for (const scenario of [
      { preset: "ollama", modelId: "qwen:latest" },
      { preset: "llamacpp", modelId: "llama" },
      { preset: "custom", modelId: "generic-model", apiKey: "fixture-bearer-only" },
      {
        preset: "custom",
        modelId: "custom-header",
        apiKey: "fixture-custom-only",
        authHeader: "Authorization",
      },
      {
        preset: "custom",
        modelId: "custom-header",
        apiKey: "fixture-rotated-only",
        authHeader: "Authorization",
        reuse: true,
        update: { apiKey: "fixture-rotated-only" },
      },
      {
        preset: "custom",
        modelId: "custom-header",
        reuse: true,
        update: { removeApiKey: true },
      },
      {
        preset: "custom",
        modelId: "azure-deployment",
        apiKey: "fixture-azure-only",
        authHeader: "api-key",
        basePath: "/openai/v1",
      },
    ]) {
      await t.test(
        `${scenario.modelId}${scenario.reuse ? (scenario.apiKey ? " rotated" : " revoked") : ""}`,
        async () => {
          const offset = server.requests.length;
          const c = scenario.reuse
            ? connections.update(previous.c.id, scenario.update)
            : connections.create({
                providerId: "endpoint",
                name: scenario.modelId,
                ...(scenario.apiKey ? { apiKey: scenario.apiKey } : {}),
                endpoint: {
                  preset: scenario.preset,
                  openaiBaseUrl: `${server.origin}${scenario.basePath || "/v1"}`,
                  authHeader: scenario.authHeader || null,
                  protocols: { messages: false, responses: false, chatCompletions: true },
                  models: [
                    {
                      modelId: scenario.modelId,
                      source: "manual",
                      contextTokens: 32768,
                      outputTokens: 4096,
                    },
                  ],
                },
              });
          const a = scenario.reuse
            ? previous.a
            : store.createAssistant({
                name: scenario.modelId,
                instructions: "Check session status, then reply.",
                model: { connectionId: c.id, modelId: scenario.modelId },
              });
          await config.apply(a.id);
          const chat = scenario.reuse
            ? previous.chat
            : await runtime.client.call("sessions.create", {
                agentId: a.runtimeAgentId,
              });
          previous = { a, c, chat };
          const sent = await runtime.client.call("sessions.send", {
            key: chat.key,
            message: "Check your status, then reply.",
            idempotencyKey: crypto.randomUUID(),
          });
          const result = await runtime.client.call(
            "agent.wait",
            { runId: sent.runId, timeoutMs: 45000 },
            { timeoutMs: 50000 },
          );
          assert.equal(result.status, "ok", JSON.stringify(result));
          assert.ok(
            result.terminalReceipt?.successfulToolNames.includes("session_status"),
          );
          const requests = server.requests
            .slice(offset)
            .filter(({ input }) => input.model === scenario.modelId);
          const toolRequests = requests.filter(({ input }) => input.tools?.length);
          assert.equal(toolRequests.length, 2);
          for (const request of requests) {
            assert.equal(request.url, `${scenario.basePath || "/v1"}/chat/completions`);
            assert.equal(request.input.stream, true);
            assert.equal(
              request.headers.authorization,
              scenario.apiKey && !scenario.authHeader
                ? `Bearer ${scenario.apiKey}`
                : scenario.authHeader?.toLowerCase() === "authorization" &&
                    scenario.apiKey
                  ? scenario.apiKey
                  : scenario.authHeader && scenario.apiKey
                    ? ""
                    : undefined,
            );
            if (scenario.authHeader)
              assert.equal(
                request.headers[scenario.authHeader.toLowerCase()],
                scenario.apiKey,
              );
            if (request.input.tools)
              assert.ok(
                request.input.tools.some(
                  ({ type, function: fn }) =>
                    type === "function" && fn.name === "session_status",
                ),
              );
            if (scenario.apiKey)
              assert.equal(
                JSON.stringify(request.input).includes(scenario.apiKey),
                false,
              );
          }
          assert.ok(
            toolRequests[1].input.messages.some(
              (m) =>
                m.role === "tool" &&
                m.tool_call_id ===
                  toolRequests[1].input.messages.find(
                    (message) => message.tool_calls?.length,
                  )?.tool_calls[0].id,
            ),
          );
          const history = await runtime.client.call("chat.history", {
            sessionKey: chat.key,
            limit: 50,
          });
          assert.ok(JSON.stringify(history).includes("Provider contract complete."));
          for (const key of [
            "fixture-bearer-only",
            "fixture-custom-only",
            "fixture-azure-only",
            "fixture-rotated-only",
          ]) {
            assert.equal(JSON.stringify(history).includes(key), false);
            assert.equal(JSON.stringify(models.listCapabilities()).includes(key), false);
            assert.equal(
              JSON.stringify(await runtime.client.call("config.get", {})).includes(key),
              false,
            );
          }
        },
      );
    }
  },
);
