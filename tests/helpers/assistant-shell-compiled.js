import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { AssistantWorkflows } from "../../server/features/assistants/assistant-workflows.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { assistantModelServer } from "./assistant-model-server.js";
import { listTree, ownerAccount } from "./assistant-shell-gateway.js";

const fixtureModel = { connectionId: "fixture", modelId: "fixture-model" };
export const confirmFull = { confirmShell: true, confirmFull: true };

/**
 * AgentPier's own shell path on an isolated Gateway in team mode, wired as
 * server/application/assistant-graph.js wires it: the start compile and live
 * applies (AssistantConfig), level changes and the allowlist (AssistantService),
 * exec approval intake and decisions (AssistantWorkflows) on the supervisor's own
 * client. The owner account is simulated in the test directory (`h.owner`), never
 * the developer's HOME; its `bin` is the owner's login PATH. The model calls
 * `exec` with the command registered for the `[cmd:<label>]` in the turn's text.
 */
export async function compiledShell(t, installed, { prefix }) {
  assert.ok(path.isAbsolute(installed));
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const owner = ownerAccount(dataDir);
  owner.tree = listTree(owner.home);
  const commands = new Map();
  const tool = (input) => {
    const text = JSON.stringify(input.messages);
    const label = [...commands.keys()].find((l) => text.includes(`[cmd:${l}]`));
    return label && { name: "exec", arguments: { command: commands.get(label) } };
  };
  const model = await assistantModelServer({ tool });
  const store = new AssistantStore({ dataDir: path.join(dataDir, "store") });
  const runtime = new RuntimeSupervisor({
    dataDir,
    shellOwner: () => ({ home: owner.home, pathPrepend: [owner.bin] }),
    install: async () => ({
      version: runtimeManifest.version,
      nodePath: path.join(installed, "node/bin/node"),
      entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
    }),
  });
  const models = {
    resolve: async () => ({
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
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 4096,
          },
        ],
      },
      release() {},
    }),
    listCapabilities: () => [],
  };
  const audit = [];
  const auditLog = { append: (entry) => audit.push(entry) };
  const config = new AssistantConfig({
    store,
    models,
    workspaces: runtime.paths.workspaces,
    client: { call: (...args) => runtime.client.call(...args) },
    hostCapacity: () => 4,
  });
  const assistants = new AssistantService({
    store,
    runtime,
    config,
    models,
    audit: auditLog,
  });
  const teams = (assistants.teams = new TeamService({ assistants, autoStart: false }));
  const bridge = (teams.bridge = new TeamBridge({
    assistants,
    teams,
    generation: () => runtime.generation,
  }));
  Object.assign(config, {
    teamReady: () => bridge.status().ready,
    writeGuard: () => false,
    nativeReady: () => true,
    webToolsAvailable: () => ({}),
    shellPathPrepend: () => runtime.shell?.pathPrepend || [],
    mcpTools: () => [],
  });
  runtime.teamConfiguration = async (descriptor) => ({
    ...provisionTeamPlugin({ paths: runtime.paths, runtimeVersion: descriptor.version }),
    connection: await bridge.start(),
    hostMaxConcurrent: 4,
    native: { token: "shell-compiled-fixture" },
    profiles: store.listAssistants(),
  });
  const workflows = (assistants.workflows = new AssistantWorkflows({
    services: { assistants, audit: auditLog },
    autoStart: false,
  }));
  t.after(async () => {
    try {
      await workflows.close();
      // Closes the team service and its bridge, the runtime and the agent store.
      await assistants.close();
      await model.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  const h = {
    dataDir,
    owner,
    model,
    store,
    runtime,
    config,
    assistants,
    teams,
    workflows,
    audit,
    at: (name) => path.join(dataDir, name),
    create: (name) =>
      store.createAssistant({ name, instructions: "Run it.", model: fixtureModel }),
    // A level change through AssistantService, as the settings save it.
    level: (agent, shell, extra = {}) =>
      assistants.update(
        agent.id,
        { shell, ...extra },
        store.getAssistant(agent.id).revision,
      ),
    running: async () => (await runtime.client.call("config.get", {})).config,
    // One owner turn on a new AgentPier conversation that runs `command`, as
    // createConversation sets one up (a conversation per turn: the fixture model
    // calls its tool only before the first tool result of a session).
    async send(agent, label, command) {
      commands.set(label, command);
      const assistant = store.getAssistant(agent.id);
      const session = await runtime.client.call("sessions.create", {
        agentId: assistant.runtimeAgentId,
        label: `AgentPier ${label}`,
      });
      const conversation = store.saveConversation({
        assistantId: agent.id,
        runtimeSessionKey: session.key,
      });
      await runtime.client.call("sessions.messages.subscribe", { key: session.key });
      const { attempt } = await assistants.send(conversation.id, {
        clientRequestId: label,
        text: `Run the command. [cmd:${label}]`,
      });
      return { label, attempt, agent, from: model.requests.length };
    },
    // Waits for the turn; returns the tools offered and the last tool result.
    async settle(turn) {
      const runId =
        turn.runId ||
        assistants.ledger.getAttempt(turn.attempt.id).runtimeRunId ||
        turn.attempt.id;
      const done = await runtime.client.call(
        "agent.wait",
        { runId, timeoutMs: 60000 },
        { timeoutMs: 65000 },
      );
      t.diagnostic(`${turn.label} wait=${done.status}`);
      const requests = model.requests.filter((r) =>
        JSON.stringify(r.messages).includes(`[cmd:${turn.label}]`),
      );
      return {
        status: done.status,
        offered: requests[0]?.tools?.map((d) => d.function.name) ?? [],
        result: requests
          .flatMap((r) => r.messages || [])
          .filter((m) => m.role === "tool")
          .map((m) => String(m.content))
          .at(-1),
      };
    },
    // The exec action AgentPier made for the turn, once it awaits the owner.
    async action(turn, state = "awaiting_approval") {
      for (let n = 0; n < 300; n++) {
        const found = h.actions(turn).find((a) => a.state === state);
        if (found) return found;
        await delay(200);
      }
      assert.fail(`${turn.label}: no exec action in ${state}`);
    },
    actions: (turn) =>
      workflows.store
        .list(turn.agent.id)
        .filter((a) => a.payload?.action === "exec" && a.attemptId === turn.attempt.id),
    // The owner's decision through AssistantWorkflows.decide, as the web sends it.
    decide: (action, decision) =>
      workflows.decide(
        action.id,
        { revision: action.revision, decision },
        { kind: "owner" },
      ),
    // Until AgentPier has recorded the end of every turn (a raise waits for it).
    async idle() {
      for (let n = 0; n < 150 && assistants.ledger.pending().length; n++) {
        await assistants.reconcile().catch(() => {});
        await delay(200);
      }
      assert.deepEqual(assistants.ledger.pending(), [], "turns still open");
    },
    // A turn that must run without asking: it ends and no exec action names it.
    async silent(turn) {
      const outcome = await h.settle(turn);
      assert.deepEqual(h.actions(turn), [], `${turn.label} ran without asking`);
      return outcome;
    },
    // A direct Gateway turn on a new session, for agents AgentPier gives no owner
    // conversation (team members).
    async direct(agentId, label, command) {
      commands.set(label, command);
      const session = await runtime.client.call("sessions.create", { agentId, label });
      const sent = await runtime.client.call("sessions.send", {
        key: session.key,
        message: `Run the command. [cmd:${label}]`,
        idempotencyKey: label,
      });
      return h.settle({ label, runId: sent.runId });
    },
  };
  return h;
}

/** A user-owned program in the owner's login PATH, by its real path. */
export function ownerProgram(h, name, script) {
  const file = path.join(h.owner.bin, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return fs.realpathSync(file);
}
