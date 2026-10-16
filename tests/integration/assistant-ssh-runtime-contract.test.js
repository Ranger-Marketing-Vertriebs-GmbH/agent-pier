import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

const installed = process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME;
// The whole approval hold plus a command (agent-ssh-approvals.js), or a quick 12 s.
const holdMs = process.env.AGENTPIER_SSH_LONG_HOLD === "1" ? 235000 : 12000;
const long = { timeoutMs: 60000 };
const text = (request) => JSON.stringify(request.messages);
const toolResults = (request) =>
  JSON.stringify(request.messages.filter((m) => m.role === "tool"));

test(
  "pinned runtime offers agentpier_ssh to a granted agent, holds a long call and admits its routine",
  { skip: !installed, timeout: holdMs + 240000 },
  async (t) => {
    let runtime, reminders, model, bridge;
    t.after(async () => {
      await runtime?.close();
      await reminders?.close();
      await bridge?.close();
      await model?.close();
    });
    const f = channelFixture(t, { language: () => "en" }),
      id = f.channel.assistantId;
    f.store.updateAssistant(id, { capabilities: { memory: true, reminders: true } }, 1);
    model = await proactivityModel();
    model.reply = (request) => {
      const answered = request.messages.some((m) => m.role === "tool");
      // First: a routine's prompt quotes the recent chat, which names the chat marker.
      if (!answered && text(request).includes("SSH_ROUTINE_CONTRACT"))
        return { tool: { name: "agentpier_ssh", arguments: { action: "hosts" } } };
      if (!answered && text(request).includes("SSH_CHAT_CONTRACT"))
        return {
          tool: {
            name: "agentpier_ssh",
            arguments: { action: "execute", accessId: "host-1", command: "uptime" },
          },
        };
      return { text: "SSH_CONTRACT_DONE" };
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
    const calls = [];
    // The SSH service stands in for AgentSsh: it holds an execute for `holdMs`.
    f.assistants.workflows = {
      ssh: {
        async invoke(inv, input) {
          calls.push({ routine: !!inv.routine, action: input.action });
          if (input.action === "execute") await delay(holdMs);
          inv.assertCurrent();
          return { status: "completed", stdout: "SSH_HELD_RESULT", untrusted: true };
        },
      },
    };
    const plugin = provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    });
    bridge = new TeamBridge({
      assistants: f.assistants,
      generation: () => runtime.generation,
      teams: { store: { context: () => ({ kind: "owner" }) } },
    });
    runtime.teamConfiguration = async () => ({
      directory: plugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: connection.token },
      profiles: f.store.listAssistants(),
      sshAgents: new Set([id]),
    });
    await runtime.start();
    f.assistants.config = new AssistantConfig({
      client: runtime.client,
      store: f.store,
      workspaces: runtime.paths.workspaces,
      models: fixtureModels(model),
    });
    f.assistants.config.nativeReady = () => true;
    f.assistants.config.sshGranted = () => true;
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
    // A chat turn with a ledger attempt: the bridge binds the call to it.
    const request = f.assistants.ledger.accept(conversation.id, {
        clientRequestId: "ssh-contract",
        text: "SSH_CHAT_CONTRACT",
      }),
      attempt = f.assistants.ledger.recordAttempt(request.id);
    const sent = await runtime.client.call(
      "sessions.send",
      { key: session.key, message: request.text, idempotencyKey: attempt.id },
      long,
    );
    f.assistants.ledger.transition(attempt.id, "accepted", { runtimeRunId: sent.runId });
    const done = await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: holdMs + 60000 },
      { timeoutMs: holdMs + 65000 },
    );
    assert.equal(done.status, "ok");
    assert.ok(done.terminalReceipt.successfulToolNames.includes("agentpier_ssh"));
    assert.match(toolResults(model.requests.at(-1)), /SSH_HELD_RESULT/);
    f.assistants.ledger.transition(attempt.id, "completed");
    // A routine run reaches the bridge without an attempt and is admitted for SSH.
    const routine = await routines.create(id, {
      clientRequestId: "ssh-routine",
      name: "SSH check",
      prompt: "Check the hosts. SSH_ROUTINE_CONTRACT",
      trigger: { kind: "event", eventKind: "manual" },
    });
    await routines.trigger(id, routine.id, { eventId: "ssh-contract-1" });
    const deadline = Date.now() + 90000;
    while (!calls.some((c) => c.routine) && Date.now() < deadline) await delay(200);
    assert.deepEqual(
      calls.map((c) => [c.action, c.routine]),
      [
        ["execute", false],
        ["hosts", true],
      ],
    );
  },
);
