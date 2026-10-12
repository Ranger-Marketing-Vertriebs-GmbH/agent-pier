import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeHeartbeats } from "../../server/features/assistants/native-heartbeats.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { telegramMessages } from "../../server/features/assistant-channels/telegram-messages.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

const installed = process.env.AGENTPIER_PROACTIVITY_CONTRACT_RUNTIME;

test(
  "pinned native heartbeat job runs isolated, drops NO_REPLY and delivers content to the paired chat",
  { skip: !installed, timeout: 240000 },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    let runtime, reminders, model;
    t.after(async () => {
      await runtime?.close();
      await reminders?.close();
      await model?.close();
    });
    const f = channelFixture(t),
      id = f.channel.assistantId;
    f.store.updateAssistant(
      id,
      {
        capabilities: { memory: false, reminders: false },
        // Every hour of the day, so the job is always due within its active hours.
        heartbeat: {
          enabled: true,
          interval: "1h",
          start: 0,
          end: 24,
          timeZone: "UTC",
        },
      },
      1,
    );
    model = await proactivityModel();
    model.reply = "Your 3 pm meeting moved to 4 pm. HEARTBEATCONTRACT";
    runtime = new RuntimeSupervisor({
      dataDir: f.dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    f.assistants.runtime = runtime;
    f.assistants.requireReady = () => assert.ok(runtime.client?.ready);
    f.assistants.admit = (fn) => Promise.resolve().then(fn);
    reminders = new NativeReminders({
      assistants: f.assistants,
      channels: f.service,
      dataDir: f.dataDir,
    });
    f.assistants.reminders = reminders;
    const pushes = [];
    const heartbeats = new NativeHeartbeats({
      reminders,
      notifications: { notify: async (input) => pushes.push(input) },
    });
    const received = [];
    const complete = heartbeats.complete.bind(heartbeats);
    heartbeats.complete = (binding, event) => {
      received.push(event.summary);
      return complete(binding, event);
    };
    const connection = await reminders.start();
    await runtime.start();
    const config = await runtime.client.call("config.get", {});
    // As the compiled native configuration does (runtime-config.js).
    await runtime.client.call("config.patch", {
      baseHash: config.hash,
      raw: JSON.stringify({
        cron: {
          enabled: true,
          webhookToken: connection.token,
          webhookSsrfPolicy: { allowedHostnames: ["127.0.0.1"] },
        },
      }),
    });
    f.assistants.config = new AssistantConfig({
      client: runtime.client,
      store: f.store,
      workspaces: runtime.paths.workspaces,
      models: fixtureModels(model),
    });
    await f.assistants.config.apply(id);
    await heartbeats.sync(id);
    const agent = f.store.getAssistant(id);
    const ours = async () =>
      (await reminders.jobs(f.store.getAssistant(id))).filter((j) =>
        j.declarationKey?.startsWith("agentpier-reminder:"),
      );
    const [job] = await ours();
    // OpenClaw's own per-agent heartbeat stays off (agents.defaults.heartbeat 0m).
    const native = (await reminders.jobs(agent)).filter(
      (j) => j.declarationKey === `heartbeat:${agent.runtimeAgentId}`,
    );
    assert.ok(native.every((j) => j.enabled === false));
    assert.equal(job.declarationKey.startsWith("agentpier-reminder:"), true);
    assert.equal(job.enabled, true);
    assert.equal(job.schedule.tz, "UTC");
    assert.equal(job.sessionTarget, "isolated");
    assert.ok(job.state.nextRunAtMs > Date.now(), "the hourly schedule is armed");

    const runs = async (count) => {
      const deadline = Date.now() + 60000;
      let entries = [];
      while (Date.now() < deadline) {
        entries = (await runtime.client.call("cron.runs", { id: job.id, limit: 10 }))
          .entries;
        if (entries.filter((e) => e.action === "finished").length >= count) break;
        await delay(250);
      }
      return entries;
    };
    const force = async () =>
      assert.equal(
        (await runtime.client.call("cron.run", { id: job.id, mode: "force" })).enqueued,
        true,
      );
    await force();
    const deadline = Date.now() + 60000;
    while (!f.service.outbox.all(f.channel.id).length && Date.now() < deadline)
      await delay(200);
    const [delivered] = f.service.outbox.all(f.channel.id);
    assert.equal(delivered?.kind, "heartbeat");
    const prefix = telegramMessages(f.channel).heartbeatPrefix;
    assert.equal(delivered.text, `${prefix} ${model.reply}`);
    assert.equal(delivered.chatId, f.channel.chatId);
    assert.deepEqual(
      pushes.map((p) => p.kind),
      ["agent-checkin"],
    );
    const calls = model.requests.filter((r) => JSON.stringify(r).includes("NO_REPLY"));
    assert.ok(calls.length > 0, "the check-in prompt reached the model");
    assert.ok(
      calls.every((r) => !r.tools?.length),
      "an agent without memory checks in without tools",
    );

    model.reply = "NO_REPLY";
    await force();
    const after = await runs(2);
    assert.equal(after.filter((e) => e.action === "finished").length, 2);
    await delay(1000);
    assert.equal(f.service.outbox.all(f.channel.id).length, 1, "NO_REPLY stays silent");
    assert.equal(pushes.length, 1);
    t.diagnostic(
      `Webhook summaries received: ${JSON.stringify(received)}; run delivery statuses: ${JSON.stringify(after.map((e) => e.deliveryStatus))}.`,
    );

    // Switching check-ins off removes the native job.
    f.store.updateAssistant(
      id,
      { heartbeat: { ...agent.heartbeat, enabled: false } },
      f.store.getAssistant(id).revision,
    );
    await heartbeats.sync(id);
    assert.deepEqual(await ours(), []);
  },
);
