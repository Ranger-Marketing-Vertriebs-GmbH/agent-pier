import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { compiledShell } from "../helpers/assistant-shell-compiled.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";
import { routineTools } from "../../server/features/assistants/native-capabilities.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { lockedTools } from "../../server/features/users/user-agent-lock.js";

// agentpier_coding_session (AGENTPIER-225) against the pinned Gateway: AgentPier
// compiles the tool for an own agent and never for a user agent, names the agent's
// session projects in its AGENTS.md, a model call reaches TeamBridge and
// AgentCodingSessions with the agent's own projects, a routine run's toolsAllow
// admits it, and a wait of the full 100 s finishes inside the plugin's 125 s timeout.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const tool = "agentpier_coding_session";
const userAccess = {
  mode: "own",
  members: [{ userId: "user-fixture", level: "extended" }],
  released: [],
};
const routineMark = "CODING_ROUTINE_CONTRACT";

test(
  "pinned Gateway: an own agent drives coding sessions through the compiled tool",
  {
    skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
    timeout: contractTimeout(330000),
  },
  async (t) => {
    // The model calls the tool with the arguments registered for `[cmd:<label>]`.
    const calls = new Map();
    const h = await compiledShell(t, installed, {
      prefix: "coding-session-contract-",
      tool: (input) => {
        const text = JSON.stringify(input.messages);
        const label = [...calls.keys()].find((l) => text.includes(`[cmd:${l}]`));
        return label ? { name: tool, arguments: calls.get(label) } : null;
      },
    });
    const { store, workflows, runtime, config } = h;

    // A project with coding sessions on for the own agent, and the services the
    // tool reads: no account, connection, secret or session of the developer.
    const memory = new ProjectMemory({ dataDir: h.at("memory") });
    t.after(() => memory.close());
    const folder = h.at("shop");
    fs.mkdirSync(folder);
    const project = await memory.register(folder);
    const activity = new Map();
    Object.assign(workflows.s, {
      memory,
      pipelineDefinitions: { listPipelines: () => [] },
      accounts: { list: () => [{ id: "local-codex", name: "Codex", tool: "codex" }] },
      providerConnections: { list: () => [] },
      secrets: { list: () => [] },
      sshAccesses: { list: () => [] },
      nonoSandbox: { executable: () => null },
      sessions: {
        async get(id) {
          if (!activity.has(id)) throw Object.assign(Error("gone"), { status: 404 });
          return { id, status: "running", tool: "codex", name: "Codex · shop" };
        },
      },
      activity: { read: async (session) => ({ state: activity.get(session.id) }) },
      requests: { listAll: () => [] },
    });
    config.codingSessions = (agent) => workflows.sessions.projects(agent.id);

    const owner = h.create("Owner");
    workflows.access.save(
      owner.id,
      {
        projectIds: [project.id],
        pipelineIds: [],
        memoryWrite: true,
        autonomous: false,
        publish: false,
        sessionProjectIds: [project.id],
      },
      0,
    );
    const user = h.create("User");
    store.changeUserAgent(user.id, { userAccess });
    await runtime.start();
    for (const agent of [owner, user]) await config.apply(agent.id);

    // 1. The compiled entries: the own agent holds the tool, the user agent denies it.
    const entries = (await h.running()).agents.entries;
    const entryOf = (agent) => entries[store.getAssistant(agent.id).runtimeAgentId];
    assert.ok(entryOf(owner).tools.allow.includes(tool), "own agent holds the tool");
    assert.ok(!entryOf(user).tools.allow.includes(tool), "user agent never holds it");
    assert.ok(lockedTools.includes(tool));
    assert.ok(entryOf(user).tools.deny.includes(tool));
    const ownerAgentId = store.getAssistant(owner.id).runtimeAgentId;
    const instructions = fs.readFileSync(
      path.join(runtime.paths.workspaces, owner.id, "AGENTS.md"),
      "utf8",
    );
    assert.match(instructions, /\n## Coding sessions\n/);
    assert.ok(
      instructions.includes(
        `${JSON.stringify(project.name)} (projectId ${JSON.stringify(project.id)})`,
      ),
    );

    // 2. An owner turn's options call reaches AgentCodingSessions through the bridge
    // and returns the agent's project.
    calls.set("options", { action: "options" });
    const options = await h.settle(await h.send(owner, "options", "unused"));
    t.diagnostic(`options=${options.result?.slice(0, 600)}`);
    assert.equal(options.status, "ok");
    assert.ok(options.offered.includes(tool));
    assert.ok(options.result.includes(project.id), "the fixture's project");
    assert.ok(options.result.includes("local-codex"));

    // 3. A routine run's toolsAllow admits the tool: the model is offered it.
    const session = await createGatewaySession(runtime.client, {
      agentId: ownerAgentId,
      label: "Routine target",
    });
    const job = await runtime.client.call("cron.add", {
      name: "Coding routine",
      agentId: ownerAgentId,
      enabled: false,
      deleteAfterRun: false,
      schedule: { kind: "every", everyMs: 3600000 },
      wakeMode: "now",
      sessionTarget: "current",
      sessionKey: session.key,
      payload: {
        kind: "agentTurn",
        message: `Check the sessions. ${routineMark}`,
        timeoutSeconds: 120,
        lightContext: false,
        toolsAllow: [...routineTools],
      },
      delivery: { mode: "none" },
    });
    await runtime.client.call("cron.run", { id: job.id, mode: "force" });
    let routine;
    for (let n = 0; n < 300 && !routine; n++) {
      routine = h.model.requests.find((r) =>
        JSON.stringify(r.messages).includes(routineMark),
      );
      if (!routine) await delay(200);
    }
    assert.ok(routine, "the routine run reached the model");
    const routineOffered = routine.tools?.map((d) => d.function.name) ?? [];
    t.diagnostic(`routine tools=${JSON.stringify(routineOffered)}`);
    assert.ok(routineOffered.includes(tool), "toolsAllow admits the tool");
    assert.ok(!routineOffered.includes("exec"), "the run stays capped");

    // 4. A wait of the full 100 s on the agent's own working session ends with its
    // timeout result, inside the plugin's 125 s call timeout.
    const sessionId = "contract-session";
    activity.set(sessionId, "working");
    workflows.sessions.store.insert({
      sessionId,
      assistantId: owner.id,
      conversationId: "contract-chat",
      projectId: project.id,
      origin: { class: "owner" },
      inherited: null,
      worktree: null,
      seen: { state: "idle", at: Date.now() },
      observed: null,
      lastSentAt: null,
      wakeSeq: 0,
      ended: false,
      createdAt: Date.now(),
    });
    calls.set("wait", { action: "wait", sessionId, timeoutSeconds: 100 });
    const turn = await h.send(owner, "wait", "unused");
    const started = Date.now();
    const runId =
      h.assistants.ledger.getAttempt(turn.attempt.id).runtimeRunId || turn.attempt.id;
    const done = await runtime.client.call(
      "agent.wait",
      { runId, timeoutMs: 180000 },
      { timeoutMs: 185000 },
    );
    const elapsed = Date.now() - started;
    const result = h.model.requests
      .filter((r) => JSON.stringify(r.messages).includes("[cmd:wait]"))
      .flatMap((r) => r.messages || [])
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content))
      .at(-1);
    t.diagnostic(`wait=${done.status} after ${elapsed} ms: ${result}`);
    assert.equal(done.status, "ok");
    assert.ok(elapsed >= 99000, "the wait used its 100 s");
    assert.match(result, /"state":\s*"working"/);
    assert.match(result, /"reason":\s*"timeout"/);
  },
);
