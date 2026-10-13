import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { AgentAttachments } from "../../server/features/assistants/agent-attachments.js";
import { publicMessages } from "../../server/features/assistants/conversations.js";
import { withAttachments } from "../../server/features/assistants/attachment-history.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";

// Opt-in: the pinned Gateway takes AgentPier's attachment shape, shows images to a
// model that declares image input, and keeps the sent text for the chat history.
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test(
  "pinned Gateway accepts chat attachments and shows images to vision models",
  { skip: !installed && "set AGENTPIER_ASSISTANT_PROVIDER_RUNTIME", timeout: 240000 },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-attachments-"));
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    const store = new AssistantStore({ dataDir });
    const server = await assistantModelServer({ tool: null });
    t.after(async () => {
      try {
        await runtime.close();
        store.close();
        await server.close();
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
    const attachments = new AgentAttachments({ store, models, config });
    for (const images of [true, false]) {
      await t.test(images ? "vision model" : "text-only model", async () => {
        const modelId = `fixture-${images ? "vision" : "text"}`;
        const connection = connections.create({
          providerId: "endpoint",
          name: modelId,
          endpoint: {
            preset: "custom",
            openaiBaseUrl: server.url,
            authHeader: null,
            protocols: { messages: false, responses: false, chatCompletions: true },
            models: [
              {
                modelId,
                source: "manual",
                contextTokens: 32768,
                outputTokens: 4096,
                images,
              },
            ],
          },
        });
        const agent = store.createAssistant({
          name: modelId,
          instructions: "Reply.",
          model: { connectionId: connection.id, modelId },
        });
        await config.apply(agent.id);
        const chat = await runtime.client.call("sessions.create", {
          agentId: agent.runtimeAgentId,
        });
        const conversation = store.saveConversation({
          assistantId: agent.id,
          runtimeSessionKey: chat.key,
        });
        const requestId = `request-${modelId}`;
        const photo = await attachments.stage(conversation.id, "dot.png", png);
        const notes = await attachments.stage(
          conversation.id,
          "notes.md",
          Buffer.from("# Notes\n"),
        );
        attachments.claim(conversation.id, [photo.id, notes.id], requestId);
        const turn = await attachments.delivery(
          { id: requestId, text: "Look at this." },
          agent.id,
        );
        assert.equal(Boolean(turn.attachments), images);
        const offset = server.requests.length;
        const idempotencyKey = crypto.randomUUID();
        const sent = await runtime.client.call("sessions.send", {
          key: chat.key,
          ...turn,
          idempotencyKey,
        });
        const result = await runtime.client.call(
          "agent.wait",
          { runId: sent.runId, timeoutMs: 45000 },
          { timeoutMs: 50000 },
        );
        assert.equal(result.status, "ok", JSON.stringify(result));
        const prompt = JSON.stringify(
          server.requests.slice(offset).filter((input) => input.model === modelId),
        );
        assert.equal(
          prompt.includes(`data:image/png;base64,${png.toString("base64")}`),
          images,
        );
        // Both models are told where the copies are, relative to their workspace.
        assert.match(prompt, /attachments\/\d{8}-\d{6}-[0-9a-f]{8}-notes\.md/);
        const workspace = path.join(runtime.paths.workspaces, agent.id, "attachments");
        assert.equal(fs.readdirSync(workspace).length, 2);
        const history = await runtime.client.call("chat.history", {
          sessionKey: chat.key,
          limit: 50,
        });
        const [user] = publicMessages(history.messages).filter((m) => m.role === "user");
        assert.equal(user.text, turn.message);
        assert.equal(user.turnKey, idempotencyKey);
        const shown = withAttachments(
          [user],
          [{ id: requestId, text: "Look at this." }],
          {
            attempts: new Map([[user.turnKey, requestId]]),
            byRequest: attachments.forConversation(conversation.id),
          },
        );
        assert.equal(shown[0].text, "Look at this.");
        assert.deepEqual(
          shown[0].attachments.map((file) => file.name),
          ["dot.png", "notes.md"],
        );
      });
    }
  },
);
