import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { assistantRoutineModel } from "../helpers/assistant-routine-model.js";
const installed = process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME;
test(
  "pinned native disabled event routine executes once and hands generated output to the outbox",
  { skip: !installed, timeout: 180000 },
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
    f.store.updateAssistant(id, { capabilities: { memory: false, reminders: true } }, 1);
    model = await assistantRoutineModel();
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
    const routines = new NativeRoutines({ reminders }),
      connection = await reminders.start();
    await runtime.start();
    const config = await runtime.client.call("config.get", {});
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
      models: {
        resolve: () => ({
          providerId: "fixture",
          modelRef: "fixture/fixture-model",
          provider: {
            baseUrl: model.url,
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [
              {
                id: "fixture-model",
                name: "Fixture",
                contextWindow: 32768,
                maxTokens: 4096,
              },
            ],
          },
          release() {},
        }),
      },
    });
    const routine = await routines.create(id, {
      clientRequestId: "contract-event",
      name: "Meal plan",
      prompt: "Generate a new meal plan. ROUTINE_NATIVE_CONTRACT",
      trigger: { kind: "event", eventKind: "manual" },
    });
    const receipt = await routines.trigger(id, routine.id, {
      eventId: "contract-event-1",
    });
    assert.equal(receipt.status, "queued");
    const deadline = Date.now() + 60000;
    while (!f.service.outbox.all(f.channel.id).length && Date.now() < deadline)
      await delay(200);
    assert.equal(
      f.service.outbox.all(f.channel.id).length,
      1,
      "native webhook must deliver the completed generated result",
    );
    assert.equal(f.service.outbox.all(f.channel.id)[0].text, "A useful assistant reply.");
    const calls = model.requests.filter((r) =>
      JSON.stringify(r.messages).includes("ROUTINE_NATIVE_CONTRACT"),
    );
    assert.ok(calls.length > 0);
    assert.ok(
      calls.every((r) => !r.tools?.length),
      "unattended execution must advertise no tools",
    );
    assert.deepEqual(
      await routines.trigger(id, routine.id, { eventId: "contract-event-1" }),
      receipt,
    );
    const job = (await reminders.jobs(f.store.getAssistant(id))).find(
      (j) => j.id === reminders.bindings.get(routine.id).nativeId,
    );
    assert.equal(job.enabled, false);
    const runs = await routines.runs(id, routine.id);
    assert.equal(runs.entries.filter((r) => r.status === "ok").length, 1);
    await routines.remove(id, routine.id);
    assert.equal((await routines.list(id)).routines.length, 0);
  },
);
