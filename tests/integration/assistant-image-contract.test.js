import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AgentAttachments } from "../../server/features/assistants/agent-attachments.js";
import { AgentShares } from "../../server/features/assistants/agent-shares.js";
import { GeneratedImages } from "../../server/features/assistants/generated-images.js";
import { ImagePolicy } from "../../server/features/assistants/image-policy.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { fixtureModels } from "../helpers/assistant-proactivity-model.js";

// Opt-in: a disposable pinned OpenClaw whose image provider is a local fake of the
// OpenAI Images API (OpenClaw's own QA switch admits a loopback endpoint), so no
// ChatGPT account is used and no credits are spent. The ChatGPT route itself
// (OAuth through the Codex Responses backend) stays unqualified here.
const installed = process.env.AGENTPIER_IMAGE_CONTRACT_RUNTIME;
const long = { timeoutMs: 60000 };

function grey(size = 64) {
  const rows = [];
  for (let y = 0; y < size; y++)
    rows.push(Buffer.from([0, ...Array(size * 3).fill(180)]));
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// The agent's model and the OpenAI Images API on one loopback server.
async function fakes(png) {
  const state = { requests: [], images: [] };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    if (req.url.includes("/images/")) {
      state.images.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ created: 1, data: [{ b64_json: png.toString("base64") }] }),
      );
    }
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model" }] }));
    }
    const input = JSON.parse(body || "{}");
    state.requests.push(input);
    // Only the newest owner message decides, and only before its tool call.
    const last = input.messages.findLastIndex((m) => m.role === "user");
    const newest = JSON.stringify(input.messages[last] || "");
    const remote = newest.includes("REMOTE_CONTRACT");
    const asked = remote || newest.includes("DRAW_CONTRACT");
    const called = input.messages
      .slice(last + 1)
      .some((m) => m.role === "assistant" && m.tool_calls);
    const tools = (input.tools || []).map((t) => t.function?.name);
    const call =
      asked && !called && tools.includes("image_generate")
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call-image",
                type: "function",
                function: {
                  name: "image_generate",
                  arguments: JSON.stringify({
                    prompt: "a grey square",
                    ...(remote ? { image: "https://example.com/secret.png" } : {}),
                  }),
                },
              },
            ],
          }
        : null;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish] of [
      [call || { content: "IMAGE_REPLY" }, null],
      [{}, call ? "tool_calls" : "stop"],
    ])
      res.write(
        `data: ${JSON.stringify({ id: "image-contract", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(state, {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  });
}

test(
  "pinned OpenClaw creates an image for an agent and AgentPier hands it to the owner",
  { skip: !installed && "set AGENTPIER_IMAGE_CONTRACT_RUNTIME", timeout: 300000 },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    const png = grey();
    const model = await fakes(png);
    let runtime, bridge;
    t.after(async () => {
      await runtime?.close();
      await bridge?.close();
      await model.close();
    });
    const f = channelFixture(t, { language: () => "en" });
    const id = f.channel.assistantId;
    f.store.updateAssistant(
      id,
      { capabilities: { memory: false, reminders: false, createImages: true } },
      1,
    );
    runtime = new RuntimeSupervisor({
      dataDir: f.dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    // OpenClaw's QA switch for a loopback image endpoint; production never sets it.
    const spawn = runtime.spawn.bind(runtime);
    runtime.spawn = (command, args, options) =>
      spawn(command, args, {
        ...options,
        env: { ...options.env, OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER: "1" },
      });
    f.assistants.runtime = runtime;
    const plugin = provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    });
    bridge = new TeamBridge({
      assistants: f.assistants,
      generation: () => runtime.generation,
      teams: { store: { context: () => null } },
    });
    // What AgentPier compiles while a ChatGPT account is signed in.
    const webTools = {
      search: { provider: "duckduckgo", unavailable: true },
      browser: { available: false },
      searchPlugins: {},
      images: { ready: true },
    };
    runtime.teamConfiguration = async () => ({
      directory: plugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "contract-hook" },
      profiles: f.store.listAssistants(),
      webTools,
    });
    await runtime.start();
    const started = await runtime.client.call("config.get", {});
    assert.ok(started.config.tools.allow.includes("image_generate"));
    assert.deepEqual(started.config.agents.defaults.mediaModels.image, {
      primary: "openai/gpt-image-2",
      timeoutMs: 180000,
    });
    f.assistants.config = new AssistantConfig({
      client: runtime.client,
      store: f.store,
      workspaces: runtime.paths.workspaces,
      models: fixtureModels(model),
    });
    f.assistants.config.nativeReady = () => true;
    f.assistants.config.webToolsAvailable = () => ({ createImages: true });
    // The plugin's guard checks and counts every call through the bridge.
    f.assistants.config.writeGuard = () => true;
    const audit = [];
    f.assistants.audit = { append: (event) => audit.push(event) };
    f.assistants.imagePolicy = new ImagePolicy({ assistants: f.assistants });
    await f.assistants.config.apply(id);
    // The fake stands in for the account: the OpenAI provider with a test key.
    await patchConfig(runtime.client, () => ({
      patch: {
        models: {
          providers: {
            openai: { baseUrl: model.url, apiKey: "contract-key", models: [] },
          },
        },
      },
    }));
    const agent = f.store.getAssistant(id);
    const session = await runtime.client.call(
      "sessions.create",
      { agentId: agent.runtimeAgentId, label: `AgentPier ${id}` },
      long,
    );
    const conversation = {
      ...f.store.getConversation(f.channel.conversationId),
      runtimeSessionKey: session.key,
    };
    f.store.db
      .prepare("UPDATE conversations SET session_key=?, body=? WHERE id=?")
      .run(session.key, JSON.stringify(conversation), conversation.id);
    const sent = await runtime.client.call(
      "sessions.send",
      {
        key: session.key,
        message: "DRAW_CONTRACT a grey square",
        idempotencyKey: randomUUID(),
      },
      long,
    );
    await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    const offered = model.requests[0].tools.map((tool) => tool.function.name);
    t.diagnostic(`agent tools=${JSON.stringify(offered)}`);
    assert.ok(offered.includes("image_generate"));
    // The tool guard audited the call: one generation, without the prompt.
    assert.deepEqual(
      audit.filter((e) => e.details.kind === "image-generation").map((e) => e.details),
      [{ kind: "image-generation" }],
    );
    // The background completion writes the image into the session.
    let page;
    const deadline = Date.now() + 90000;
    do {
      page = await runtime.client.call("chat.history", {
        sessionKey: session.key,
        limit: 30,
      });
      if (JSON.stringify(page.messages).includes("artifact_managed_image_")) break;
      await delay(500);
    } while (Date.now() < deadline);
    assert.equal(model.images.length, 1, "the image request reached the fake provider");
    const completion = page.messages.find((m) =>
      JSON.stringify(m.content).includes("artifact_managed_image_"),
    );
    t.diagnostic(`completion=${JSON.stringify(completion).slice(0, 1200)}`);
    // AgentPier copies it into the chat's share store from the Gateway.
    const attachments = new AgentAttachments({
      store: f.store,
      config: { workspaces: runtime.paths.workspaces },
    });
    const service = Object.assign(f.assistants, { attachments, changed() {} });
    service.shares = new AgentShares({ assistants: service, channels: f.service });
    service.teams = { store: { context: () => ({ kind: "owner" }) } };
    const images = new GeneratedImages(service);
    await images.observe(conversation);
    const [message] = attachments.sharedFor(conversation.id);
    assert.equal(message?.attachments[0]?.type, "image/png");
    const content = await attachments.content(message.attachments[0].id);
    assert.deepEqual(content.body, png);
    // A second look copies nothing again.
    await images.observe(conversation);
    assert.equal(attachments.sharedFor(conversation.id).length, 1);
    // A reference from the web is refused for an agent without web reading.
    const before = model.requests.length;
    const remote = await runtime.client.call(
      "sessions.send",
      {
        key: session.key,
        message: "REMOTE_CONTRACT use this picture",
        idempotencyKey: randomUUID(),
      },
      long,
    );
    await runtime.client.call(
      "agent.wait",
      { runId: remote.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    const results = JSON.stringify(
      model.requests.slice(before).map((r) => r.messages.at(-1)),
    );
    t.diagnostic(`remote reference result=${results.slice(0, 400)}`);
    assert.match(results, /Read web pages/);
    assert.equal(model.images.length, 1, "no second image request was sent");
  },
);
