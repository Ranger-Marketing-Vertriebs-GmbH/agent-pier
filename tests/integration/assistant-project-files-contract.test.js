import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

// Project folder access against the pinned Gateway (AGENTPIER-123): in the owner's
// turn a granted folder write lands through agentpier_workspace, while an ungranted
// project and the native write tool aimed at the folder are refused.
const installed = process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME;
const long = { timeoutMs: 60000 };

test(
  "pinned Gateway: a granted project folder write lands, an ungranted one is refused",
  { skip: !installed, timeout: 300000 },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    let runtime, model, bridge;
    t.after(async () => {
      await runtime?.close();
      await bridge?.close();
      await model?.close();
    });
    const f = await workflowFixture(t);
    const folder = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-folder-")),
    );
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const granted = await f.memory.register(folder);
    f.store.updateAssistant(
      f.id,
      { capabilities: { memory: true, reminders: false } },
      1,
    );
    f.workflows.access.save(
      f.id,
      {
        ...f.policy,
        projectIds: [granted.id, f.project.id],
        projectFiles: { [granted.id]: "write" },
      },
      0,
    );
    model = await proactivityModel();
    const steps = [
      {
        name: "agentpier_workspace",
        arguments: {
          action: "file_write",
          projectId: granted.id,
          path: "docs/plan.md",
          content: "PLAN\n",
        },
      },
      {
        name: "agentpier_workspace",
        arguments: {
          action: "file_write",
          projectId: f.project.id,
          path: "planted.md",
          content: "PLANTED\n",
        },
      },
      {
        name: "write",
        arguments: { path: path.join(folder, "native.md"), content: "NATIVE\n" },
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
    bridge = new TeamBridge({
      assistants: f.assistants,
      generation: () => runtime.generation,
      teams: f.assistants.teams,
    });
    const plugin = provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    });
    runtime.teamConfiguration = async () => ({
      directory: plugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "project-files-fixture" },
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
    config.writeGuard = () => true;
    config.projectFolders = (assistant) => f.workflows.folders.forAgent(assistant);
    f.assistants.config = config;
    await config.apply(f.id);
    const workspace = path.join(runtime.paths.workspaces, f.id);
    assert.match(
      fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8"),
      /## Project folders[\s\S]*read and write/,
    );
    const agent = f.store.getAssistant(f.id);
    const session = await runtime.client.call(
      "sessions.create",
      { agentId: agent.runtimeAgentId, label: `AgentPier ${f.id}` },
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
    // The owner's own running turn (the fixture's default context).
    const request = f.assistants.ledger.accept(conversation.id, {
      clientRequestId: randomUUID(),
      text: "Write the plan into the project.",
    });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    f.assistants.ledger.transition(attempt.id, "running");
    const from = model.requests.length;
    const sent = await runtime.client.call(
      "sessions.send",
      {
        key: session.key,
        message: "Write the plan into the project.",
        idempotencyKey: randomUUID(),
      },
      long,
    );
    await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    const results = model.requests
      .slice(from)
      .at(-1)
      .messages.filter((m) => m.role === "tool")
      .map((m) => String(m.content).slice(0, 300));
    t.diagnostic(`results=${JSON.stringify(results)}`);
    assert.equal(results.length, steps.length, "every step reached a tool result");
    assert.equal(fs.readFileSync(path.join(folder, "docs/plan.md"), "utf8"), "PLAN\n");
    assert.match(results[1], /PROJECT_NOT_GRANTED/);
    assert.equal(fs.existsSync(path.join(f.project.cwd, "planted.md")), false);
    assert.equal(fs.existsSync(path.join(folder, "native.md")), false, "native write");
    assert.match(results[2], /limited to this agent's workspace/);
  },
);
