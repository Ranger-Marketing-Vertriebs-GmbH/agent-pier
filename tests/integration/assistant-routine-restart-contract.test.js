import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { WriteGuardReapply } from "../../server/features/assistants/write-guard-reapply.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

const installed = process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME;
const long = { timeoutMs: 60000 };
const isRoutine = (request) =>
  JSON.stringify(request.messages).includes("ROUTINE_RESTART_CONTRACT");
const offered = (request) => request.tools?.map((tool) => tool.function.name) ?? [];

async function until(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(200);
  }
  return false;
}

// AGENTPIER-80: a Gateway start compiles every agent without write and edit until
// the team plugin reports its write guard. A scheduled routine fires without any
// AgentPier apply, so the guard report itself must bring the tools back.
test(
  "a scheduled routine writes after a fresh Gateway start without a chat turn",
  { skip: !installed, timeout: 300000 },
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
    const notePath = "memory/restart-note.md";
    model = await proactivityModel();
    model.reply = (request) => {
      if (!isRoutine(request)) return { text: "Chat reply." };
      const results = request.messages.filter((m) => m.role === "tool").length;
      if (results === 0)
        return {
          tool: {
            name: "write",
            arguments: { path: notePath, content: "RESTART_NOTE\nSENT\n" },
          },
        };
      if (results === 1)
        return {
          tool: {
            name: "edit",
            arguments: { path: notePath, oldText: "SENT", newText: "SENT_EDITED" },
          },
        };
      return { text: "ROUTINE_RESULT after restart." };
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
    });
    f.assistants.reminders = reminders;
    const routines = new NativeRoutines({ reminders });
    f.assistants.routines = routines;
    const connection = await reminders.start();
    const plugin = provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    });
    // The real bridge and the real write guard report decide whether writes exist.
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
    // The current Gateway client, as the graph wires it: a restart replaces it.
    const client = { call: (...args) => runtime.client.call(...args) };
    f.assistants.config = new AssistantConfig({
      client,
      store: f.store,
      workspaces: runtime.paths.workspaces,
      models: fixtureModels(model),
    });
    f.assistants.config.nativeReady = () => true;
    f.assistants.config.writeGuard = () => bridge.guardLive();
    // As assistant-graph.js wires it: a guard report re-applies the memory agents.
    const reapply = new WriteGuardReapply({
      assistants: f.assistants,
      live: () => bridge.guardLive(),
      generation: () => runtime.generation,
      warn: (message) => t.diagnostic(message),
    });
    bridge.onGuard = () => reapply.request();
    // As AssistantService does on every ready: no earlier apply describes a new
    // start, and readiness asks for the pass a guard reported during the start.
    runtime.on("status", (state) => {
      if (state.availability !== "ready") return;
      f.assistants.config.reset();
      reapply.request();
    });
    await runtime.start();
    assert.ok(await until(() => bridge.guardLive(), 30000), "first guard report");
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
    // Saved by the owner before the restart; its schedule lies far in the future.
    const routine = await routines.create(id, {
      clientRequestId: "restart-contract",
      name: "Morning note",
      prompt: "Record the morning note. ROUTINE_RESTART_CONTRACT",
      trigger: { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" },
    });
    const jobId = reminders.bindings.get(routine.id).nativeId;
    const allowed = async () => {
      const entries = (await runtime.client.call("config.get", {})).config?.agents
        ?.entries;
      const entry = Array.isArray(entries)
        ? entries.find((a) => a.id === agent.runtimeAgentId)
        : entries?.[agent.runtimeAgentId];
      return entry?.tools?.allow || [];
    };
    assert.ok((await allowed()).includes("write"), "the owner's apply granted write");

    // A fresh Gateway start: no chat turn, no settings save, no "Run once".
    await runtime.restart();
    t.diagnostic(`restarted into generation ${runtime.generation}`);
    assert.ok(await until(() => bridge.guardLive(), 30000), "guard report after restart");
    const regained = await until(async () => (await allowed()).includes("write"), 30000);
    t.diagnostic(`tools.allow after the guard report=${JSON.stringify(await allowed())}`);

    // The native scheduler fires the job by its own clock; AgentPier applies nothing.
    const offset = model.requests.length;
    await runtime.client.call(
      "cron.update",
      {
        id: jobId,
        patch: {
          schedule: { kind: "at", at: new Date(Date.now() + 3000).toISOString() },
        },
      },
      long,
    );
    assert.ok(
      await until(() => model.requests.slice(offset).some(isRoutine), 120000),
      "the scheduled run started",
    );
    await until(() => f.service.outbox.all(f.channel.id).length > 0, 90000);
    const runRequests = model.requests.slice(offset).filter(isRoutine);
    const runTools = offered(runRequests[0]);
    t.diagnostic(`scheduled run tools=${JSON.stringify(runTools)}`);
    assert.ok(regained, "the guard report re-applied write and edit");
    for (const name of ["write", "edit"])
      assert.ok(runTools.includes(name), `the scheduled run is offered ${name}`);
    const workspace = path.join(runtime.paths.workspaces, id);
    assert.equal(
      fs.readFileSync(path.join(workspace, notePath), "utf8"),
      "RESTART_NOTE\nSENT_EDITED\n",
      "the scheduled run wrote and edited its note",
    );
  },
);
