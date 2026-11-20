import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";
import {
  AZURE_TOOLS_REFUSAL,
  azureReasoningServer,
} from "../helpers/azure-reasoning-server.js";

// AGENTPIER-425: an Azure reasoning deployment refuses function tools together with
// `reasoning_effort` on Chat Completions. A keyed connection that offers Responses runs
// agents on Responses, where the same tool loop succeeds. Only immutable app/node
// binaries are reused; every state, account and config path is generated here.
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
const KEY = "fixture-azure-responses-only";
const DEPLOYMENT = "gpt-6.2-sol";

test(
  "pinned Gateway runs an Azure reasoning deployment's tool loop over Responses",
  { skip: !installed, timeout: contractTimeout(180000) },
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
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-responses-"));
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    const store = new AssistantStore({ dataDir });
    const server = await azureReasoningServer({ apiKey: KEY, deployment: DEPLOYMENT });
    t.after(async () => {
      try {
        await runtime.close();
        store.close();
        await server.close();
        for (const name of ["gateway-console.log", "openclaw.log"]) {
          const file = path.join(runtime.paths.logs, name);
          const output = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
          assert.equal(output.includes(KEY), false, "the key stays out of runtime logs");
        }
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    const connections = new ProviderConnections({ dataDir });
    const models = new AssistantModels({ connections });
    await runtime.start();
    const config = new AssistantConfig({
      runtime,
      models,
      store,
      workspaces: runtime.paths.workspaces,
    });
    const turn = async () => {
      const c = connections.create({
        providerId: "endpoint",
        name: "Azure",
        apiKey: KEY,
        endpoint: {
          preset: "azure",
          openaiBaseUrl: `${server.origin}/openai/v1`,
          authHeader: "api-key",
          protocols: { messages: false, responses: true, chatCompletions: true },
          // As the connection test proposes for Azure reasoning deployments.
          adapterCapabilities: {
            chatCompletions: { maxTokensField: "max_completion_tokens" },
          },
          models: [
            {
              modelId: DEPLOYMENT,
              source: "manual",
              contextTokens: 200000,
              outputTokens: 32000,
            },
          ],
        },
      });
      const a = store.createAssistant({
        name: "Azure",
        instructions: "Check session status, then reply.",
        model: { connectionId: c.id, modelId: DEPLOYMENT },
      });
      await config.apply(a.id);
      const chat = await createGatewaySession(runtime.client, {
        agentId: a.runtimeAgentId,
      });
      const offset = server.requests.length;
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
      const history = await runtime.client.call("chat.history", {
        sessionKey: chat.key,
        limit: 50,
      });
      return { result, history, requests: server.requests.slice(offset) };
    };

    await t.test("an agent turn with a tool call succeeds on Responses", async () => {
      const { result, history, requests } = await turn();
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.ok(result.terminalReceipt?.successfulToolNames.includes("session_status"));
      assert.ok(JSON.stringify(history).includes("Azure contract complete."));
      assert.ok(requests.length >= 2);
      for (const request of requests) {
        assert.equal(request.url, "/openai/v1/responses");
        assert.equal(request.input.stream, true);
        // The key travels in `api-key` alone, never as a bearer token or in the body.
        assert.equal(request.headers["api-key"], KEY);
        assert.equal(request.headers.authorization || "", "");
        assert.equal(JSON.stringify(request.input).includes(KEY), false);
        assert.equal(request.input.max_tokens, undefined);
        assert.equal(request.input.max_completion_tokens, undefined);
        assert.equal(request.input.reasoning_effort, undefined);
      }
      const toolRequests = requests.filter(({ input }) => input.tools?.length);
      assert.equal(toolRequests.length, 2);
      assert.ok(
        toolRequests[0].input.tools.some(
          ({ type, name }) => type === "function" && name === "session_status",
        ),
      );
      assert.ok(
        toolRequests[1].input.input.some(
          (item) =>
            item.type === "function_call_output" && item.call_id === "call_azure_status",
        ),
      );
    });

    await t.test(
      "the server refuses tools with reasoning_effort on Chat only",
      async () => {
        // The refusal the Azure qualification hit; Responses accepts the same request.
        const tool = { name: "session_status", parameters: { type: "object" } };
        const post = (route, body) =>
          fetch(`${server.origin}/openai/v1/${route}`, {
            method: "POST",
            headers: { "content-type": "application/json", "api-key": KEY },
            body: JSON.stringify({ model: DEPLOYMENT, stream: true, ...body }),
          });
        const chat = await post("chat/completions", {
          messages: [{ role: "user", content: "Status?" }],
          tools: [{ type: "function", function: tool }],
          reasoning_effort: "low",
        });
        assert.equal(chat.status, 400);
        assert.equal((await chat.json()).error.message, AZURE_TOOLS_REFUSAL);
        const responses = await post("responses", {
          input: [{ role: "user", content: "Status?" }],
          tools: [{ type: "function", ...tool }],
          reasoning: { effort: "low" },
        });
        assert.equal(responses.status, 200);
        assert.match(await responses.text(), /"name":"session_status"/);
      },
    );
  },
);
