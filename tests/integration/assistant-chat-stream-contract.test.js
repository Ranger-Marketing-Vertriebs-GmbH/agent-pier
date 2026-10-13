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
import { GatewayClient } from "../../server/features/assistants/gateway-client.js";

const chunks = ["Noch", " keine", " neuen Meldungen."];
const reply = chunks.join("");

// Streams the reply in pieces, each held until the test releases it, so every step
// below waits for an observed frame instead of guessing at Gateway timing.
async function gatedModelServer() {
  const gates = chunks.map(() => Promise.withResolvers());
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
    for (const [i, content] of chunks.entries()) {
      emit({ content });
      await gates[i].promise;
    }
    emit({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    release: (i) => gates[i].resolve(),
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
    const server = await gatedModelServer();
    t.after(async () => {
      try {
        chunks.forEach((_, i) => server.release(i));
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
    const own = [];
    t.after(
      runtime.client.subscribe((event) => {
        if (event.event === "chat" && event.payload?.sessionKey === chat.key)
          own.push(event.payload);
      }),
    );
    const until = async (done, label) => {
      for (let i = 0; i < 300; i++) {
        if (done()) return;
        await delay(100);
      }
      assert.fail(`${label}: ${JSON.stringify({ own, late })}`);
    };
    const streams = new ChatStreams();
    let ownText;
    const accumulate = () => {
      for (const frame of own.splice(0))
        if (frame.state === "delta") {
          ownDeltas.push(frame);
          ownText = streams.delta(frame) ?? ownText;
        }
      return ownText;
    };
    const ownDeltas = [];
    const late = [];
    const sent = await runtime.client.call("sessions.send", {
      key: chat.key,
      message: "Any news?",
      idempotencyKey: crypto.randomUUID(),
    });
    await until(() => accumulate() === chunks[0], "the first piece streams");
    server.release(0);
    await until(() => accumulate() === chunks[0] + chunks[1], "the second piece streams");
    // A second connection joins mid-run: the Gateway keeps delivery receipts per
    // connection, so its first frame of the run must be a snapshot again.
    const client = runtime.client;
    const joiner = new GatewayClient({
      url: client.url,
      token: client.token,
      certPath: client.certPath,
    });
    t.after(() => joiner.close());
    await joiner.connect();
    t.after(
      joiner.subscribe((event) => {
        if (event.event === "chat" && event.payload?.sessionKey === chat.key)
          late.push(event.payload);
      }),
    );
    await joiner.call("sessions.messages.subscribe", { key: chat.key });
    server.release(1);
    await until(() => accumulate() === reply, "the whole reply streams");
    await until(() => late.some((f) => f.state === "delta"), "the joiner gets a frame");
    server.release(2);
    const result = await client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 45000 },
      { timeoutMs: 50000 },
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    const diagnostic = JSON.stringify({ ownDeltas, late });
    const shape = (f) => ({ deltaText: f.deltaText, snapshot: "message" in f });
    t.diagnostic(JSON.stringify({ own: ownDeltas.map(shape), joiner: late.map(shape) }));
    // The run's first frame on a connection is a snapshot of the reply so far.
    assert.equal(ownDeltas[0].message?.content?.[0]?.text, chunks[0], diagnostic);
    const joined = late.find((f) => f.state === "delta");
    // Its deltaText is still only the appended part; `message` carries the rest.
    assert.equal(joined.message?.content?.[0]?.text, reply, diagnostic);
    assert.ok(reply.endsWith(joined.deltaText), diagnostic);
    // Later frames may drop `message` and carry only the appended text: a fragment
    // that is never the reply so far. Snapshots stay legal (a slow socket's dropped
    // frame forces one), so only the existence of the stripped shape is asserted.
    assert.ok(
      ownDeltas.slice(1).some((f) => f.message === undefined && !f.replace),
      diagnostic,
    );
    // AgentPier's accumulation turned the frames into the whole reply (awaited above).
    assert.equal(ownText, reply, diagnostic);
  },
);
