import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { ChatStreams } from "../../server/features/assistants/chat-stream.js";

const chunks = ["Noch", " keine", " neuen", " Meldungen."];

// Streams the reply in pieces far apart enough (the Gateway paces live text at 75 ms)
// that each one reaches the client as its own `chat` delta frame.
async function slowModelServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") return res.writeHead(404).end();
    let bytes = "";
    for await (const part of req) bytes += part;
    const input = JSON.parse(bytes);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "stream-contract",
          object: "chat.completion.chunk",
          model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    for (const content of chunks) {
      emit({ content });
      await delay(400);
    }
    emit({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// Reuse only immutable app/node binaries; every state path is freshly generated.
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
test(
  "pinned Gateway streams a reply as one snapshot followed by appended deltas",
  { skip: !installed, timeout: 180000 },
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
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-stream-contract-"));
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    const store = new AssistantStore({ dataDir });
    const server = await slowModelServer();
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
    const c = connections.create({
      providerId: "endpoint",
      name: "stream",
      endpoint: {
        preset: "custom",
        openaiBaseUrl: `${server.origin}/v1`,
        authHeader: null,
        protocols: { messages: false, responses: false, chatCompletions: true },
        models: [
          {
            modelId: "stream-model",
            source: "manual",
            contextTokens: 32768,
            outputTokens: 4096,
          },
        ],
      },
    });
    const a = store.createAssistant({
      name: "News",
      instructions: "Reply briefly.",
      model: { connectionId: c.id, modelId: "stream-model" },
    });
    await config.apply(a.id);
    const chat = await runtime.client.call("sessions.create", {
      agentId: a.runtimeAgentId,
    });
    await runtime.client.call("sessions.messages.subscribe", { key: chat.key });
    const frames = [];
    const unsubscribe = runtime.client.subscribe((event) => {
      if (event.event === "chat" && event.payload?.sessionKey === chat.key)
        frames.push(event.payload);
    });
    t.after(unsubscribe);
    const sent = await runtime.client.call("sessions.send", {
      key: chat.key,
      message: "Any news?",
      idempotencyKey: crypto.randomUUID(),
    });
    const result = await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 45000 },
      { timeoutMs: 50000 },
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    await delay(500);
    const deltas = frames.filter((f) => f.state === "delta");
    const diagnostic = JSON.stringify(frames);
    t.diagnostic(
      JSON.stringify(
        deltas.map((f) => ({ deltaText: f.deltaText, snapshot: "message" in f })),
      ),
    );
    assert.ok(deltas.length >= 2, `several delta frames: ${diagnostic}`);
    // The first frame is a snapshot: `message` holds the whole reply so far.
    assert.equal(deltas[0].message?.content?.[0]?.text, deltas[0].deltaText, diagnostic);
    // Later frames on the same connection drop `message`; `deltaText` is only the
    // appended part, so taken alone it is a fragment, never the reply so far.
    for (const frame of deltas.slice(1)) {
      assert.equal(frame.message, undefined, diagnostic);
      assert.equal(typeof frame.deltaText, "string", diagnostic);
      assert.notEqual(frame.replace, true, diagnostic);
    }
    assert.equal(deltas.map((f) => f.deltaText).join(""), chunks.join(""), diagnostic);
    // AgentPier's accumulation turns the frames into the growing reply.
    const streams = new ChatStreams();
    const texts = deltas.map((f) => streams.delta(f));
    assert.equal(texts.at(-1), chunks.join(""), diagnostic);
    for (let i = 1; i < texts.length; i++)
      assert.ok(texts[i].startsWith(texts[i - 1]), diagnostic);
    assert.ok(
      frames.some((f) => f.state === "final"),
      `the run ends with a final frame: ${diagnostic}`,
    );
  },
);
