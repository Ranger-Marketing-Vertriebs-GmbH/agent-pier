import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fixtureImage } from "../helpers/device-service-fixture.js";
import { png } from "../helpers/image-bytes.js";
import { memoryDeviceSource } from "../helpers/memory-device-source.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { deferredToolNames } from "../helpers/assistant-model-server.js";
import { createDevices } from "../../server/application/device-wiring.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";

// agentpier_device on the pinned Gateway (AGENTPIER_TEAM_CONTRACT_RUNTIME): OpenClaw
// lists the installed plugin's tool and describes its schema, the model's call by
// name reaches the device actions through the attempt-bound bridge and the devices'
// own gate, and a screenshot comes back to the model as an image, never as base64
// text. The device lives on a source in memory that answers `screencap` with a PNG.
const packageRoot = process.env.AGENTPIER_TEAM_CONTRACT_RUNTIME;
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

test(
  "pinned Gateway: an agent's device screenshot reaches its model as an image",
  { skip: !packageRoot, timeout: contractTimeout(240000) },
  async (t) => {
    assert.ok(path.isAbsolute(packageRoot));
    const runtimeVersion = JSON.parse(
      fs.readFileSync(
        path.join(packageRoot, "app/node_modules/openclaw/package.json"),
        "utf8",
      ),
    ).version;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-device-contract-"));
    const store = new AssistantStore({ dataDir }),
      ledger = new RequestLedger(store.db);
    const agent = store.createAssistant({
      name: "Mobile tester",
      instructions: "Look at the phone.",
      model: { connectionId: "fixture", modelId: "fixture-model" },
    });
    const requests = [];
    const model = http.createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      // First the tool's schema, then the screenshot, then the reply.
      const step = body.messages.filter((m) => m.role === "tool").length;
      const call = [
        { name: "tool_describe", arguments: { id: "agentpier_device" } },
        {
          name: "agentpier_device",
          arguments: { action: "screenshot", device: "Pixel" },
        },
      ][step];
      const tool = !!call;
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: `device-call-${step}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          }
        : { content: "The phone shows its home screen." };
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
        teamPlugin: provisionTeamPlugin({ paths: runtime.paths, runtimeVersion }),
      }),
    });
    // The turn's origin as AgentPier records it: the owner's own message.
    const assistants = {
      store,
      ledger,
      runtime,
      changed() {},
      teams: { store: { context: () => ({ kind: "owner" }) } },
    };
    // Android devices as the application wires them, on a source in memory.
    const source = memoryDeviceSource({ image: fixtureImage });
    const sdk = { available: () => null, manifest: { image: { id: fixtureImage } } };
    const adb = [];
    source.answer = (_record, args) => {
      adb.push(args.join(" "));
      return args.join(" ") === "exec-out screencap -p" ? { stdout: png } : undefined;
    };
    const services = {
      config: {
        dataDir,
        androidDevices: { service: { sdk, sources: { emulator: source } } },
      },
      assistants,
      audit: { append() {} },
    };
    const { devices, agentGrants, actions } = createDevices(services);
    Object.assign(services, {
      devices,
      agentDeviceGrants: agentGrants,
      deviceActions: actions,
    });
    assistants.workflows = { a: assistants, s: services };
    const pixel = await devices.create({
      name: "Pixel",
      creator: { kind: "owner", id: "owner", name: "" },
    });
    agentGrants.set(agent.id, {
      devices: [{ deviceId: pixel.id, manage: false }],
      create: false,
    });
    const bridge = new TeamBridge({
      assistants,
      generation: () => runtime.generation,
      teams: {},
    });
    t.after(async () => {
      await runtime.close();
      await bridge.close();
      await devices.shutdown();
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
      hostMaxConcurrent: 4,
      native: { token: "device-fixture" },
    });
    await runtime.start();
    const config = new AssistantConfig({
      store,
      workspaces: runtime.paths.workspaces,
      runtime,
      teamReady: () => bridge.status().ready,
      nativeReady: () => true,
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
                input: ["text", "image"],
                contextWindow: 32768,
                maxTokens: 4096,
              },
            ],
          },
          release() {},
        }),
      },
    });
    config.nativeReady = () => true;
    // Android devices are installed and can run on this host (device-wiring.js).
    config.devicesAvailable = () => !devices.availability();
    await config.apply(agent.id);
    const created = await createGatewaySession(runtime.client, {
      agentId: agent.runtimeAgentId,
      label: "Device contract",
    });
    const chat = store.saveConversation({
      assistantId: agent.id,
      runtimeSessionKey: created.key,
    });
    const request = ledger.accept(chat.id, {
        clientRequestId: "device",
        text: "What does the phone show?",
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
      { runId: sent.runId, timeoutMs: 90000 },
      { timeoutMs: 95000 },
    );
    assert.equal(done.status, "ok");
    assert.ok(deferredToolNames(requests[0]).includes("agentpier_device"), "listed");
    const described = String(
      requests.flatMap((r) => r.messages).find((m) => m.role === "tool").content,
    );
    t.diagnostic(`described=${described.slice(0, 600)}`);
    assert.match(described.replaceAll("\\", ""), /"screenshot"/);
    assert.ok(done.terminalReceipt.successfulToolNames.includes("agentpier_device"));
    // The call reached the device through the gate, once.
    assert.deepEqual(
      adb.filter((command) => command.includes("screencap")),
      ["exec-out screencap -p"],
    );
    // What the model got back: the line that names the screenshot, and the image
    // itself as an image part, not as text.
    const last = requests.at(-1).messages;
    const answered = JSON.stringify(last);
    t.diagnostic(`answered=${answered.slice(-1500)}`);
    assert.match(answered, /Screenshot of device \\+"Pixel\\+"/);
    assert.match(answered, /untrusted data from the device/);
    const images = last.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((part) => part?.type === "image_url")
        : [],
    );
    assert.deepEqual(
      images.map((part) => part.image_url.url),
      [dataUrl],
    );
    const texts = last.flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : (message.content || []).flatMap((part) => (part?.text ? [part.text] : [])),
    );
    assert.ok(
      !texts.some((text) => text.includes(png.toString("base64"))),
      "no base64 as text",
    );
  },
);
