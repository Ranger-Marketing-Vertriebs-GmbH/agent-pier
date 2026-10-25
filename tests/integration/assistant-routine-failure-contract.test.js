import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { withRoutineResults } from "../../server/features/assistants/routine-results.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

const installed = process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME;
const long = { timeoutMs: 60000 };
const isRoutine = (request) =>
  JSON.stringify(request.messages).includes("ROUTINE_FAILURE_CONTRACT");
// A provider key in the provider's error text: it must never reach the owner.
const leakedKey = `sk-${"x".repeat(32)}`;

async function until(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(250);
  }
  return null;
}

// AGENTPIER-239: a failed routine run tells the owner and the agent why. The pinned
// runtime runs a routine whose model endpoint fails, then one the Gateway restart
// interrupts; AgentPier reads the cause from cron.list, cron.runs and the
// completion webhook.
test(
  "pinned native routine failures surface their cause, redacted",
  { skip: !installed, timeout: contractTimeout(420000) },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    let runtime, reminders, model, bridge;
    t.after(async () => {
      await runtime?.close();
      await reminders?.close();
      await bridge?.close();
      await model?.close();
    });
    const f = channelFixture(t, { language: () => "en" }),
      id = f.channel.assistantId;
    f.store.updateAssistant(
      id,
      { capabilities: { memory: true, reminders: true, webFetch: false } },
      1,
    );
    model = await proactivityModel();
    let mode = "hold";
    let held = null;
    model.reply = (request) => {
      if (!isRoutine(request)) return { text: "Chat reply." };
      if (mode === "error")
        return {
          status: 401,
          error: `Incorrect API key provided: ${leakedKey}. You can find your API key in your account.`,
        };
      // Held open until the Gateway restarts underneath the run.
      return new Promise((resolve) => {
        held = () => resolve({ text: "too late" });
      });
    };
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
      notifications: { notify: async () => {} },
    });
    f.assistants.reminders = reminders;
    const routines = new NativeRoutines({ reminders });
    f.assistants.routines = routines;
    const connection = await reminders.start();
    const completions = [];
    const complete = reminders.complete.bind(reminders);
    reminders.complete = (bindingId, event) => {
      completions.push(event);
      return complete(bindingId, event);
    };
    const plugin = provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    });
    bridge = new TeamBridge({
      assistants: f.assistants,
      generation: () => runtime.generation,
      teams: { store: { context: () => null } },
    });
    runtime.teamConfiguration = async () => ({
      directory: plugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: connection.token },
      profiles: f.store.listAssistants(),
    });
    await runtime.start();
    // The current Gateway client: the restart below replaces it.
    const client = { call: (...args) => runtime.client.call(...args) };
    f.assistants.config = new AssistantConfig({
      client,
      store: f.store,
      workspaces: runtime.paths.workspaces,
      models: fixtureModels(model),
    });
    f.assistants.config.nativeReady = () => true;
    f.assistants.config.writeGuard = () => true;
    await f.assistants.config.apply(id);
    const agent = f.store.getAssistant(id);
    const session = await runtime.client.call(
      "sessions.create",
      { agentId: agent.runtimeAgentId, label: `AgentPier ${id}` },
      long,
    );
    const conversation = f.store.getConversation(f.channel.conversationId);
    f.store.db
      .prepare("UPDATE conversations SET session_key=?, body=? WHERE id=?")
      .run(
        session.key,
        JSON.stringify({ ...conversation, runtimeSessionKey: session.key }),
        conversation.id,
      );
    const routine = await routines.create(id, {
      clientRequestId: "failure-contract",
      name: "Zabbix check",
      prompt: "Check the Zabbix problems. ROUTINE_FAILURE_CONTRACT",
      trigger: { kind: "event", eventKind: "manual" },
    });
    const listed = async () =>
      (await routines.list(id)).routines.find((r) => r.id === routine.id);
    const jobId = reminders.bindings.get(routine.id).nativeId;
    const job = async () => (await reminders.jobs(agent)).find((j) => j.id === jobId);

    // 1. The Gateway restarts while a run waits on its model (the owner's case).
    assert.equal(
      (await routines.trigger(id, routine.id, { eventId: "failure-1" })).status,
      "queued",
    );
    assert.ok(await until(() => held, 90000), "the run reached its model");
    await runtime.restart();
    held();
    const interrupted = await until(async () => (await listed())?.lastFailure, 120000);
    t.diagnostic(`after restart lastFailure=${JSON.stringify(interrupted)}`);
    t.diagnostic(
      `after restart state=${JSON.stringify((await job()).state).slice(0, 1500)}`,
    );
    assert.ok(interrupted, "the interrupted run is recorded as failed");
    assert.equal(interrupted.reason, "gateway-restart");
    const restarted = (await routines.runs(id, routine.id)).entries;
    t.diagnostic(`runs after restart=${JSON.stringify(restarted)}`);
    assert.equal(restarted[0].failure?.reason, "gateway-restart");

    // 2. The model endpoint refuses the next run; its key never reaches the owner.
    mode = "error";
    assert.equal(
      (await routines.trigger(id, routine.id, { eventId: "failure-2" })).status,
      "queued",
    );
    const failed = await until(
      () => completions.find((e) => e.status === "error" && e.runAtMs > interrupted.atMs),
      120000,
    );
    assert.ok(failed, "the failed run's completion webhook arrived");
    t.diagnostic(`webhook=${JSON.stringify(failed).slice(0, 1500)}`);
    const state = (await job()).state;
    t.diagnostic(`job state=${JSON.stringify(state).slice(0, 1500)}`);
    const refused = (await listed()).lastFailure;
    t.diagnostic(`lastFailure=${JSON.stringify(refused)}`);
    assert.equal((await listed()).lastRunStatus, "error");
    assert.equal(refused.reason, "model");
    assert.ok(refused.message, "OpenClaw's message is kept as the detail");
    assert.ok(refused.message.length <= 500);
    assert.equal(refused.consecutive, 2, "both runs failed in a row");
    const { entries } = await routines.runs(id, routine.id);
    t.diagnostic(`runs=${JSON.stringify(entries)}`);
    assert.equal(entries[0].failure?.reason, "model");
    // The chat's failure note names the cause too.
    const notes = withRoutineResults(
      [],
      reminders.results.forConversation(f.channel.conversationId),
    );
    assert.equal(notes.at(-1)?.event, "routine-failed");
    assert.ok(notes.at(-1).failure?.reason, "the chat note carries a cause");
    for (const shown of [refused, entries[0].failure, notes.at(-1).failure])
      assert.doesNotMatch(JSON.stringify(shown), new RegExp(leakedKey));
  },
);
