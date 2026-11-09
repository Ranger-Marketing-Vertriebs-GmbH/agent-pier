import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { randomBytes } from "node:crypto";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { normalizeOpenRouter } from "../../server/features/providers/catalog-normalization.js";
import { AgentAttachments } from "../../server/features/assistants/agent-attachments.js";
import { publicMessages } from "../../server/features/assistants/conversations.js";
import { withOpenClawEntries } from "../../server/features/assistants/runtimes/openclaw/openclaw-sessions.js";
import { withAttachments } from "../../server/features/assistants/attachment-history.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";

// Opt-in: the pinned Gateway takes AgentPier's attachment shape, shows images to a
// model that declares image input, keeps the sent text for the chat history, and
// names a large image by a media:// reference without staging it in the workspace.
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// An incompressible PNG of about 3.3 MB, stored without compression.
function largePng(width = 1100, height = 1000) {
  const rows = [];
  for (let y = 0; y < height; y++)
    rows.push(Buffer.concat([Buffer.from([0]), randomBytes(width * 3)]));
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test(
  "pinned Gateway accepts chat attachments and shows images to models with image input",
  {
    skip: !installed && "set AGENTPIER_ASSISTANT_PROVIDER_RUNTIME",
    timeout: contractTimeout(240000),
  },
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
    // OpenRouter's catalog lists input modalities per model.
    const catalog = normalizeOpenRouter({
      data: [
        ["google/gemini-3.8-flash", ["text", "image"]],
        ["z-ai/glm-5.3", ["text"]],
      ].map(([id, input]) => ({
        id,
        name: id,
        architecture: { input_modalities: input, output_modalities: ["text"] },
        supported_parameters: ["tools"],
      })),
    });
    const models = new AssistantModels({
      connections,
      catalog: {
        get: (_provider, modelId) => {
          const found = catalog.find((m) => m.modelId === modelId);
          if (!found) throw Error("not in catalog");
          return found;
        },
      },
    });
    // The compiled OpenRouter transport unchanged, except that it reaches the stub.
    const routed = {
      resolve: (input) => {
        const lease = models.resolve(input);
        return lease.provider?.baseUrl === "https://openrouter.ai/api/v1"
          ? { ...lease, provider: { ...lease.provider, baseUrl: server.url } }
          : lease;
      },
    };
    await runtime.start();
    const config = new AssistantConfig({
      runtime,
      models: routed,
      store,
      workspaces: runtime.paths.workspaces,
    });
    const attachments = new AgentAttachments({ store, models, config });
    const endpoint = (modelId, images) =>
      connections.create({
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
    const router = connections.create({
      providerId: "openrouter",
      name: "Router",
      apiKey: "fixture-openrouter-key",
    });
    for (const [name, modelId, images, connection] of [
      ["vision endpoint model", "fixture-vision", true, endpoint("fixture-vision", true)],
      [
        "text-only endpoint model",
        "fixture-text",
        false,
        endpoint("fixture-text", false),
      ],
      ["OpenRouter model with image input", "google/gemini-3.8-flash", true, router],
      ["OpenRouter text model", "z-ai/glm-5.3", false, router],
    ]) {
      await t.test(name, async () => {
        assert.equal(models.imageInput({ connectionId: connection.id, modelId }), images);
        const agent = store.createAssistant({
          name: modelId,
          instructions: "Reply.",
          model: { connectionId: connection.id, modelId },
        });
        await config.apply(agent.id);
        const chat = await createGatewaySession(runtime.client, {
          agentId: agent.runtimeAgentId,
        });
        const conversation = store.saveConversation({
          assistantId: agent.id,
          runtimeSessionKey: chat.key,
        });
        const requestId = `request-${name}`;
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
        const [user] = publicMessages(withOpenClawEntries(history.messages)).filter(
          (m) => m.role === "user",
        );
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
    // A phone photo above 2 MB is offloaded to the Gateway's media store, shared by
    // every agent, and the prompt names it by a media:// reference: the tool guard
    // keeps that reference and media/inbound/ from the chats of a shared agent
    // (team-plugin/inbound-media.js). The pinned Gateway stages no chat image in the
    // workspace any more (older ones did, under media/inbound/openclaw-staged-*/).
    await t.test("a large image reaches the model by a media:// reference", async () => {
      const connection = endpoint("fixture-vision-large", true);
      const agent = store.createAssistant({
        name: "large",
        instructions: "Reply.",
        model: { connectionId: connection.id, modelId: "fixture-vision-large" },
      });
      await config.apply(agent.id);
      const chat = await createGatewaySession(runtime.client, {
        agentId: agent.runtimeAgentId,
      });
      const conversation = store.saveConversation({
        assistantId: agent.id,
        runtimeSessionKey: chat.key,
      });
      const body = largePng();
      assert.ok(body.length > 2e6);
      const photo = await attachments.stage(conversation.id, "photo.png", body);
      attachments.claim(conversation.id, [photo.id], "request-large");
      const turn = await attachments.delivery(
        { id: "request-large", text: "Look at this." },
        agent.id,
      );
      assert.equal(turn.attachments?.length, 1);
      const offset = server.requests.length;
      const sent = await runtime.client.call("sessions.send", {
        key: chat.key,
        ...turn,
        idempotencyKey: crypto.randomUUID(),
      });
      const result = await runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 45000 },
        { timeoutMs: 50000 },
      );
      assert.equal(result.status, "ok", JSON.stringify(result));
      const prompt = JSON.stringify(server.requests.slice(offset));
      assert.match(
        prompt,
        /\[media attached: media:\/\/inbound\/photo---[0-9a-f-]+\.png/,
      );
      assert.ok(prompt.includes("data:image/png;base64,"), "the model still sees it");
      const workspace = path.join(runtime.paths.workspaces, agent.id);
      assert.equal(fs.existsSync(path.join(workspace, "media")), false);
    });
  },
);
