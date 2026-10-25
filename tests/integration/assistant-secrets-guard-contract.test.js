import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

// The agent's secrets file against the pinned Gateway: no file tool changes
// .agentpier/secrets.env, not even in the owner's own turn, while the agent still
// reads it.
const installed = process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME;
const long = { timeoutMs: 60000 };
const patch = (lines) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const target = ".agentpier/secrets.env";
const seeded =
  "# Managed by AgentPier. Do not edit; changes are overwritten.\nCONTRACT_TOKEN='fixture'\n";

test(
  "pinned Gateway: file tools never change the agent's secrets file",
  { skip: !installed, timeout: 300000 },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    let runtime, model, bridge;
    t.after(async () => {
      await runtime?.close();
      await bridge?.close();
      await model?.close();
    });
    const f = channelFixture(t, { language: () => "en" }),
      id = f.channel.assistantId;
    f.store.updateAssistant(id, { capabilities: { memory: true, reminders: false } }, 1);
    model = await proactivityModel();
    // Each step calls one file tool on the secrets file; the last answers.
    const steps = [
      { name: "write", arguments: { path: target, content: "PLANTED='x'\n" } },
      {
        name: "edit",
        arguments: { path: target, oldText: "fixture", newText: "PLANTED" },
      },
      {
        name: "apply_patch",
        arguments: { input: patch([`*** Delete File: ${target}`]) },
      },
      { name: "read", arguments: { path: target } },
    ];
    model.reply = (request) => {
      const done = request.messages.filter((m) => m.role === "tool").length;
      return done < steps.length ? { tool: steps[done] } : { text: "Done." };
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
    const contexts = new Map();
    bridge = new TeamBridge({
      assistants: f.assistants,
      generation: () => runtime.generation,
      teams: { store: { context: (requestId) => contexts.get(requestId) || null } },
    });
    const plugin = provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    });
    runtime.teamConfiguration = async () => ({
      directory: plugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "secrets-guard-fixture" },
      profiles: f.store.listAssistants(),
    });
    await runtime.start();
    const config = new AssistantConfig({
      client: runtime.client,
      store: f.store,
      workspaces: runtime.paths.workspaces,
      models: fixtureModels(model),
    });
    config.nativeReady = () => true;
    // A proven guard: the agent holds write/edit, as an owner's chat turn would.
    config.writeGuard = () => true;
    await config.apply(id);
    const agent = f.store.getAssistant(id);
    const workspace = path.join(runtime.paths.workspaces, id);
    fs.mkdirSync(path.join(workspace, ".agentpier"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workspace, target), seeded, { mode: 0o600 });

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
    // The running turn AgentPier admitted: the owner's own message.
    const request = f.assistants.ledger.accept(conversation.id, {
      clientRequestId: randomUUID(),
      text: "Rotate my token.",
    });
    contexts.set(request.id, { kind: "owner" });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    f.assistants.ledger.transition(attempt.id, "running");

    const from = model.requests.length;
    const sent = await runtime.client.call(
      "sessions.send",
      { key: session.key, message: "Rotate my token.", idempotencyKey: randomUUID() },
      long,
    );
    await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    f.assistants.ledger.transition(attempt.id, "completed");
    const requests = model.requests.slice(from);
    const results = requests
      .at(-1)
      .messages.filter((m) => m.role === "tool")
      .map((m) => String(m.content).slice(0, 300));
    t.diagnostic(`runtime=${runtimeManifest.version} results=${JSON.stringify(results)}`);
    assert.equal(results.length, steps.length, "every step reached a tool result");
    assert.equal(fs.readFileSync(path.join(workspace, target), "utf8"), seeded);
    for (const result of results.slice(0, 3))
      assert.match(result, /managed by AgentPier/, result);
    // The agent reads its file; OpenClaw 2026.10.7 masks a token's value in the
    // tool result the model sees (CONTRACT_TOKEN='***').
    assert.match(results[3], /# Managed by AgentPier\./, "the agent reads its file");
    assert.match(results[3], /CONTRACT_TOKEN='/);
  },
);
