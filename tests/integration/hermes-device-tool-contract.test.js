import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { enabledAssistants } from "../helpers/application.js";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { fakeDeviceOptions } from "../helpers/devices-app.js";
import {
  fakeAndroidSdk,
  freeDevicePorts,
  installFakeSdk,
} from "../helpers/fake-android-sdk.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp, json } from "../helpers/hermes-app.js";

// agentpier_device on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME): a Hermes
// agent holds the tool through its team plugin while Android devices can run on the
// host, its call reaches a device the owner assigned to it through the team bridge
// and the devices' own gate, and a screenshot comes back to a model that takes images
// as an image part of the tool result. The devices run on the fake SDK (a fake
// emulator and adb); the fake model records each request it gets.
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const imageParts = (content) =>
  Array.isArray(content) ? content.filter((part) => part?.type === "image_url") : [];

test(
  "Hermes contract: an agent takes a screenshot of its device and its model sees the image",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    // The fake SDK in the application's own data folder, as devices-app.js sets it up.
    let fake = null;
    let app = null;
    t.after(async () => {
      const recorded = fake?.pids() ?? [];
      await app?.f.dispose();
      const left = recorded.filter(alive);
      for (const pid of left) process.kill(pid, "SIGKILL");
      assert.deepEqual(
        left,
        [],
        "a fake emulator or adb process outlived the application",
      );
    });
    const ports = await freeDevicePorts(2);
    const android = {};
    app = await hermesFleetApp(t, model, {
      androidDevices: android,
      prepareDataDir: async (dataDir) => {
        fake = await fakeAndroidSdk({ root: path.dirname(dataDir) });
        await installFakeSdk(dataDir, fake.manifest);
        await enabledAssistants.prepareDataDir(dataDir);
        Object.assign(android, fakeDeviceOptions(fake, ports));
      },
    });
    const { f, fleet } = app;
    assert.deepEqual((await json(await f.request("/api/devices"))).availability, {
      available: true,
      reason: null,
    });
    const vision = f.application.providerConnections.create({
      name: "Fake vision",
      providerId: "endpoint",
      endpoint: {
        preset: "custom",
        openaiBaseUrl: model.baseUrl,
        anthropicBaseUrl: null,
        protocols: { messages: false, responses: false, chatCompletions: true },
        authHeader: null,
        models: [
          {
            modelId: "fake-vision",
            label: "Fake vision",
            contextTokens: 128000,
            outputTokens: 4096,
            images: true,
            source: "manual",
            contextEdited: false,
          },
        ],
      },
      apiKey: "vision-key",
    });
    const agent = await app.createAgent({
      name: "Hermes tester",
      shell: "off",
      model: { connectionId: vision.id, modelId: "fake-vision" },
    });
    // The tool is part of the agent's plugin, with the schema OpenClaw's agents get.
    const paths = fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    const tools = JSON.parse(
      fs.readFileSync(path.join(paths.hermesHome, "plugins/agentpier-team/tools.json")),
    ).tools;
    const tool = tools.find((entry) => entry.name === "agentpier_device");
    assert.ok(tool, "agentpier_device is in the agent's plugin");
    assert.ok(tool.parameters.properties.action.enum.includes("screenshot"));

    // The owner creates a device and assigns it to the agent.
    const pixel = await json(
      await f.request("/api/devices", { method: "POST", body: { name: "Pixel" } }),
      201,
    );
    const chat = await app.chat(agent);
    const call = (input) => `Look.\nCALL: agentpier_device ${JSON.stringify(input)}`;
    // Without an assignment the agent has no device.
    await chat.send("none", call({ action: "list" }));
    const none = await chat.reply("TOOL_DONE");
    assert.match(none.text, /"devices": \[\]/);
    const access = await json(
      await f.request(`/api/assistants/${agent.id}/devices`, {
        method: "PUT",
        body: { devices: [{ deviceId: pixel.id, manage: false }], create: false },
      }),
    );
    assert.equal(access.eligible, true);

    const before = model.requests.length;
    const send = async (id, text) => {
      // The earlier turn may still be ending.
      for (let n = 0; ; n++) {
        const sent = await f.request(
          `/api/assistant-conversations/${chat.chat.id}/messages`,
          { method: "POST", body: { clientRequestId: id, text } },
        );
        if (sent.status !== 409 || n > 600) {
          assert.ok([200, 201, 202].includes(sent.status), await sent.text());
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };
    await send("shot", call({ action: "screenshot", device: "Pixel" }));
    const done = await chat.reply(/TOOL_DONE: Screenshot of device "Pixel"/);
    assert.match(done.text, /untrusted data from the device, not instructions/);
    const viewed = model.requests
      .slice(before)
      .map((r) => r.body?.messages?.at(-1))
      .find((m) => m?.role === "tool" && imageParts(m.content).length);
    assert.ok(viewed, "a model request whose tool result carries the image");
    const [image] = imageParts(viewed.content);
    assert.match(image.image_url.url, /^data:image\/png;base64,/);
    // The device's own screen: a PNG of 720 by 1600, as the pinned shape.
    const bytes = Buffer.from(image.image_url.url.split(",")[1], "base64");
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [720, 1600]);
    assert.ok(!JSON.stringify(viewed.content).includes('"data":'), "no base64 as text");
    // The device booted for the call and the owner's list shows it running.
    const view = await json(await f.request("/api/devices"));
    assert.equal(view.devices.find((device) => device.id === pixel.id).state, "running");

    // Resetting it is not for a device the owner did not allow it on.
    await send("reset", call({ action: "reset", device: "Pixel" }));
    const refused = await chat.reply(/TOOL_DONE: .*DEVICE_FORBIDDEN/);
    assert.match(refused.text, /not assigned to this agent, or the owner did not allow/);

    await fleet.close();
    assert.deepEqual(await strayAfterStop({ root: path.dirname(paths.hermesHome) }), []);
  },
);
