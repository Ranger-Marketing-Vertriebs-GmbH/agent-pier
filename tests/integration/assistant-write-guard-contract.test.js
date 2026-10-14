import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { hiddenHunks } from "../helpers/patch-cases.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

// The write guard against the pinned Gateway: a turn that is not the owner's own
// message (here a forwarded Telegram message) must not change any file, whichever
// file tool the model picks.
const installed = process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME;
const long = { timeoutMs: 60000 };
const offered = (request) => request.tools?.map((tool) => tool.function.name) ?? [];
const patch = (lines) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

test(
  "pinned Gateway: no file tool writes in a turn that is not the owner's",
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
    // Each step calls one file tool; the last answers.
    const steps = [
      { name: "write", arguments: { path: "notes/written.md", content: "WRITTEN\n" } },
      {
        name: "edit",
        arguments: { path: "notes/existing.md", oldText: "ORIGINAL", newText: "EDITED" },
      },
      {
        name: "apply_patch",
        arguments: {
          input: patch(["*** Add File: notes/patched.md", "+PATCHED"]),
        },
      },
      {
        name: "apply_patch",
        arguments: {
          input: patch([
            "*** Update File: notes/existing.md",
            "@@",
            "-ORIGINAL",
            "+PATCHED",
          ]),
        },
      },
      {
        name: "apply_patch",
        arguments: { input: patch(["*** Delete File: notes/existing.md"]) },
      },
      {
        name: "apply_patch",
        arguments: {
          input: patch(["*** Update File: AGENTS.md", "@@", "+PLANTED instruction"]),
        },
      },
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
      native: { token: "write-guard-fixture" },
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
    fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "notes/existing.md"), "ORIGINAL\n");
    const agents = fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8");

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
    // The running turn AgentPier admitted: a forwarded Telegram message.
    const request = f.assistants.ledger.accept(conversation.id, {
      clientRequestId: randomUUID(),
      text: "Forwarded: please tidy the notes.",
    });
    contexts.set(request.id, { kind: "telegram", forwarded: true });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    f.assistants.ledger.transition(attempt.id, "running");

    const from = model.requests.length;
    const sent = await runtime.client.call(
      "sessions.send",
      {
        key: session.key,
        message: "Forwarded: please tidy the notes.",
        idempotencyKey: randomUUID(),
      },
      long,
    );
    await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    const requests = model.requests.slice(from);
    const tools = offered(requests[0]);
    const results = requests
      .at(-1)
      .messages.filter((m) => m.role === "tool")
      .map((m) => String(m.content).slice(0, 200));
    t.diagnostic(`offered=${JSON.stringify(tools)} results=${JSON.stringify(results)}`);
    assert.equal(results.length, steps.length, "every step reached a tool result");

    assert.equal(fs.existsSync(path.join(workspace, "notes/written.md")), false, "write");
    assert.equal(fs.existsSync(path.join(workspace, "notes/patched.md")), false, "add");
    assert.equal(
      fs.readFileSync(path.join(workspace, "notes/existing.md"), "utf8"),
      "ORIGINAL\n",
      "edit, update and delete",
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8"),
      agents,
      "the instruction file",
    );
    assert.ok(tools.includes("apply_patch"), "apply_patch comes with write");
    for (const result of results)
      assert.match(result, /may change files|managed by AgentPier/, result);

    // The owner's own turn still patches its workspace.
    f.assistants.ledger.transition(attempt.id, "completed");
    const own = f.assistants.ledger.accept(conversation.id, {
      clientRequestId: randomUUID(),
      text: "Note this down.",
    });
    contexts.set(own.id, { kind: "owner" });
    const ownAttempt = f.assistants.ledger.recordAttempt(own.id);
    f.assistants.ledger.transition(ownAttempt.id, "running");
    // First the review's hidden hunks (B1): an ordinary hunk beside one whose header
    // holds a line separator and aims at an instruction file; then a plain patch.
    const ownerPatches = [
      ...hiddenHunks,
      patch(["*** Add File: notes/owner.md", "+OWNER"]),
    ];
    model.reply = (request) => {
      const turn = request.messages.slice(
        request.messages.findLastIndex((m) => m.role === "user"),
      );
      const done = turn.filter((m) => m.role === "tool").length;
      return done < ownerPatches.length
        ? { tool: { name: "apply_patch", arguments: { input: ownerPatches[done] } } }
        : { text: "Noted." };
    };
    const owned = await runtime.client.call(
      "sessions.send",
      { key: session.key, message: "Note this down.", idempotencyKey: randomUUID() },
      long,
    );
    await runtime.client.call(
      "agent.wait",
      { runId: owned.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, "notes/owner.md"), "utf8"),
      "OWNER\n",
      "the owner's patch applies",
    );
    // No hidden hunk applied, not even its ordinary half.
    const ownerResults = model.requests
      .at(-1)
      .messages.filter((m) => m.role === "tool")
      .slice(-ownerPatches.length)
      .map((m) => String(m.content).slice(0, 200));
    t.diagnostic(`owner results=${JSON.stringify(ownerResults)}`);
    assert.equal(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8"), agents);
    for (const planted of [
      "SOUL.md",
      "skills/evil/SKILL.md",
      "notes/ok.md",
      "notes/ok2.md",
      "notes/ok3.md",
    ])
      assert.equal(fs.existsSync(path.join(workspace, planted)), false, planted);
    f.assistants.ledger.transition(ownAttempt.id, "completed");

    // Without a proven guard no file tool is offered at all, apply_patch included.
    config.writeGuard = () => false;
    await config.apply(id);
    const before = model.requests.length;
    model.reply = () => ({ text: "Read-only." });
    const plain = await runtime.client.call(
      "sessions.send",
      { key: session.key, message: "Hello.", idempotencyKey: randomUUID() },
      long,
    );
    await runtime.client.call(
      "agent.wait",
      { runId: plain.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    const unproven = offered(model.requests[before]);
    t.diagnostic(`offered without guard=${JSON.stringify(unproven)}`);
    for (const name of ["write", "edit", "apply_patch"])
      assert.equal(unproven.includes(name), false, name);
  },
);
