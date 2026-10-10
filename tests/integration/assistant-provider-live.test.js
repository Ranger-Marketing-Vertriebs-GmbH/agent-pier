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

// Explicitly opt in: this makes real inference requests and may incur charges.
// Only immutable binaries are reused; no installed account/state is imported.
test(
  "live central endpoint completes a streamed assistant tool round trip",
  { skip: process.env.AGENTPIER_ASSISTANT_LIVE !== "1", timeout: 240000 },
  async (t) => {
    const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
    const baseUrl = process.env.AGENTPIER_ASSISTANT_LIVE_URL;
    const modelId = process.env.AGENTPIER_ASSISTANT_LIVE_MODEL;
    const preset = process.env.AGENTPIER_ASSISTANT_LIVE_PRESET || "custom";
    const contextTokens = Number(process.env.AGENTPIER_ASSISTANT_LIVE_CONTEXT);
    const outputTokens = Number(process.env.AGENTPIER_ASSISTANT_LIVE_OUTPUT || 2048);
    assert.ok(installed && path.isAbsolute(installed), "absolute runtime required");
    assert.ok(baseUrl && modelId, "explicit endpoint URL and model required");
    assert.ok(
      Number.isInteger(contextTokens) && contextTokens >= 4000,
      "explicit model context of at least 4000 tokens required",
    );
    assert.ok(
      Number.isInteger(outputTokens) && outputTokens >= 1024 && outputTokens <= 4096,
      "qualification output limit must be between 1024 and 4096 tokens",
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(installed, "app/node_modules/openclaw/package.json"),
          "utf8",
        ),
      ).version,
      runtimeManifest.version,
      "runtime must match the managed pin",
    );
    const keyFile = process.env.AGENTPIER_ASSISTANT_LIVE_KEY_FILE;
    let apiKey;
    if (keyFile) {
      const stat = fs.lstatSync(keyFile);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), "key file must be regular");
      assert.equal(stat.mode & 0o077, 0, "key file must be private");
      assert.ok(stat.size > 0 && stat.size <= 16384, "key file size invalid");
      apiKey = fs.readFileSync(keyFile, "utf8").trim();
      assert.ok(apiKey, "key file must contain a key");
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-provider-live-"));
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    const store = new AssistantStore({ dataDir });
    const noSecret = (value, label) => {
      if (apiKey) assert.equal(JSON.stringify(value).includes(apiKey), false, label);
    };
    t.after(async () => {
      try {
        await runtime.close();
        store.close();
        for (const name of ["gateway-console.log", "openclaw.log"]) {
          const file = path.join(runtime.paths.logs, name);
          const output = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
          noSecret(output, "credential stays out of runtime logs");
        }
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    const connections = new ProviderConnections({ dataDir });
    const connection = connections.create({
      providerId: "endpoint",
      name: "Live endpoint qualification",
      ...(apiKey ? { apiKey } : {}),
      endpoint: {
        preset,
        openaiBaseUrl: baseUrl,
        authHeader: process.env.AGENTPIER_ASSISTANT_LIVE_AUTH_HEADER || null,
        protocols: { messages: false, responses: false, chatCompletions: true },
        models: [{ modelId, source: "manual", contextTokens, outputTokens }],
      },
    });
    const models = new AssistantModels({ connections });
    await runtime.start();
    const config = new AssistantConfig({
      client: runtime.client,
      models,
      store,
      workspaces: runtime.paths.workspaces,
      teamReady: () => false,
    });
    const assistant = store.createAssistant({
      name: "Live endpoint qualification",
      instructions:
        "Call session_status exactly once. After receiving its result, reply with " +
        "the exact text: Provider contract complete. Do not call other tools.",
      model: { connectionId: connection.id, modelId },
    });
    await config.apply(assistant.id);
    const chat = await runtime.client.call("sessions.create", {
      agentId: assistant.runtimeAgentId,
    });
    let deltas = 0;
    const unsubscribe = runtime.client.subscribe((event) => {
      if (
        event.event === "chat" &&
        event.payload?.sessionKey === chat.key &&
        event.payload.state === "delta"
      )
        deltas++;
    });
    t.after(unsubscribe);
    const sent = await runtime.client.call("sessions.send", {
      key: chat.key,
      message: "Use session_status now, then provide the requested exact reply.",
      idempotencyKey: crypto.randomUUID(),
    });
    const result = await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 150000 },
      { timeoutMs: 155000 },
    );
    // Never serialize provider errors or model output into assertion diagnostics.
    assert.ok(result.status === "ok", "native model run must finish successfully");
    assert.ok(
      result.terminalReceipt?.successfulToolNames.includes("session_status"),
      "native runtime must successfully execute session_status",
    );
    const history = await runtime.client.call("chat.history", {
      sessionKey: chat.key,
      limit: 50,
    });
    const final = history.messages?.findLast((message) => message.role === "assistant");
    const text = final?.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    assert.ok(
      text?.includes("Provider contract complete."),
      "assistant must produce the requested final reply after tool execution",
    );
    assert.ok(deltas > 0, "Gateway must deliver downstream streaming deltas");
    noSecret(history, "credential stays out of conversation history");
    noSecret(models.listCapabilities(), "credential stays out of capabilities");
    noSecret(await runtime.client.call("config.get", {}), "Gateway redacts credentials");
    t.diagnostic(
      `Pinned runtime ${runtimeManifest.version}; tool succeeded; streaming observed.`,
    );
  },
);
