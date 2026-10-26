import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { SshManagement } from "../../server/features/ssh/ssh-management.js";
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
const offered = (request) => request.tools?.map((tool) => tool.function.name) ?? [];
const first = (requests, marker) => requests.find((r) => text(r).includes(marker));
// The SSH access proposal the model makes in the owner's turn (agent-ssh-proposals.js).
const proposal = {
  action: "propose",
  name: "Backup NAS",
  host: "nas.example.test",
  port: 2222,
  username: "backup",
  purpose: "SSH_ACCESS_CONTRACT check the backups",
};

test(
  "pinned runtime offers agentpier_ssh to a granted agent, holds a long call, admits its routine's SFTP action and offers SSH access proposals only in owner turns",
  { skip: !installed, timeout: holdMs + 240000 },
  async (t) => {
    let runtime, reminders, model, bridge, management;
    t.after(async () => {
      await runtime?.close();
      await reminders?.close();
      await bridge?.close();
      await model?.close();
      await management?.close();
    });
    const f = channelFixture(t, { language: () => "en" }),
      id = f.channel.assistantId;
    f.store.updateAssistant(id, { capabilities: { memory: true, reminders: true } }, 1);
    model = await proactivityModel();
    model.reply = (request) => {
      const answered = request.messages.some((m) => m.role === "tool");
      // First: a routine's prompt quotes the recent chat, which names the chat marker.
      // A routine plans an SFTP sync: the runtime accepts the file action parameters.
      if (!answered && text(request).includes("SSH_ROUTINE_CONTRACT"))
        return {
          tool: {
            name: "agentpier_ssh",
            arguments: {
              action: "sync",
              accessId: "host-2",
              direction: "up",
              remotePath: "/www",
              localPath: "site",
              exclude: ["*.map"],
              dryRun: true,
            },
          },
        };
      // The proposal turn follows the answered SSH turn in the same session: only the
      // messages after its own owner message count.
      const latest = request.messages.findLastIndex((m) => m.role === "user");
      const current = request.messages.slice(latest);
      if (
        JSON.stringify(current[0]).includes("SSH_ACCESS_CONTRACT") &&
        !current.some((m) => m.role === "tool")
      )
        return { tool: { name: "agentpier_ssh_access", arguments: proposal } };
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
    // A real SSH catalog in the disposable data directory; ssh-keyscan is a stand-in
    // that reports a generated key for any host, so no host is ever contacted.
    const keyFile = path.join(f.dataDir, "contract-host-key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyFile]);
    const hostKey = fs
      .readFileSync(`${keyFile}.pub`, "utf8")
      .split(" ")
      .slice(0, 2)
      .join(" ");
    management = new SshManagement({
      dataDir: path.join(f.dataDir, "ssh-catalog"),
      home: f.dataDir,
    });
    await management.ready;
    const scans = [];
    const run = management.store.run;
    management.store.run = async (command, args, options) => {
      if (command !== "ssh-keyscan") return run(command, args, options);
      scans.push(args.at(-1));
      return { stdout: `${args.at(-1)} ${hostKey}\n`, stderr: "" };
    };
    const actions = new AssistantActionStore(f.store.db);
    // The SSH service stands in for AgentSsh: it holds an execute for `holdMs`. The
    // proposal path (invokeSshAccess) reads the agent's turn, its actions and the catalog.
    f.assistants.workflows = {
      a: {
        ledger: f.assistants.ledger,
        store: f.store,
        teams: { store: { context: () => ({ kind: "owner" }) } },
        changed() {},
      },
      s: { sshManagement: management, assistantChannels: f.service },
      store: actions,
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
    async function ownerTurn(clientRequestId, message) {
      const request = f.assistants.ledger.accept(conversation.id, {
          clientRequestId,
          text: message,
        }),
        attempt = f.assistants.ledger.recordAttempt(request.id);
      const sent = await runtime.client.call(
        "sessions.send",
        { key: session.key, message: request.text, idempotencyKey: attempt.id },
        long,
      );
      f.assistants.ledger.transition(attempt.id, "accepted", {
        runtimeRunId: sent.runId,
      });
      const done = await runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: holdMs + 60000 },
        { timeoutMs: holdMs + 65000 },
      );
      f.assistants.ledger.transition(attempt.id, "completed");
      return { done, attempt };
    }
    const { done } = await ownerTurn("ssh-contract", "SSH_CHAT_CONTRACT");
    assert.equal(done.status, "ok");
    assert.ok(done.terminalReceipt.successfulToolNames.includes("agentpier_ssh"));
    assert.match(toolResults(model.requests.at(-1)), /SSH_HELD_RESULT/);
    // The owner's turn is offered the proposal tool; a propose call reaches the bridge,
    // scans the host key and leaves a pending proposal for the owner, nothing else.
    assert.ok(
      offered(first(model.requests, "SSH_CHAT_CONTRACT")).includes(
        "agentpier_ssh_access",
      ),
    );
    const proposed = await ownerTurn("ssh-access-contract", "SSH_ACCESS_CONTRACT");
    assert.equal(proposed.done.status, "ok");
    assert.ok(
      proposed.done.terminalReceipt.successfulToolNames.includes("agentpier_ssh_access"),
    );
    assert.match(toolResults(model.requests.at(-1)), /approval_requested/);
    assert.deepEqual(scans, ["nas.example.test"]);
    const [pending] = actions.list(id).filter((a) => a.payload.action === "ssh_access");
    assert.equal(pending.state, "awaiting_approval");
    assert.equal(pending.attemptId, proposed.attempt.id);
    assert.equal(pending.payload.host, "nas.example.test");
    assert.equal(pending.payload.port, 2222);
    assert.equal(pending.payload.hostKey, hostKey);
    assert.match(toolResults(model.requests.at(-1)), new RegExp(pending.id));
    assert.deepEqual(management.store.list(), []);
    assert.deepEqual(management.store.keyStore.list(), []);
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
        ["sync", true],
      ],
    );
    // A routine's own run keeps agentpier_ssh but is never offered a proposal.
    const routineTools = offered(first(model.requests, "SSH_ROUTINE_CONTRACT"));
    assert.ok(routineTools.includes("agentpier_ssh"), JSON.stringify(routineTools));
    assert.ok(
      !routineTools.includes("agentpier_ssh_access"),
      JSON.stringify(routineTools),
    );
  },
);
