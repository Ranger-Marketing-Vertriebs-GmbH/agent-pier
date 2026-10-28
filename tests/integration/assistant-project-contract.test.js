import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { compiledShell } from "../helpers/assistant-shell-compiled.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";
import { routineTools } from "../../server/features/assistants/native-capabilities.js";
import { projectDefinition } from "../../server/features/assistants/team-plugin/project-tool.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";

// agentpier_project (AGENTPIER-273) against the pinned Gateway: AgentPier compiles the
// tool for an own agent and never for a user agent, the Gateway offers it with its
// whole description, an owner turn's create call reaches TeamBridge and
// AgentProjects and makes the folder in the owner's default folder (a temporary
// directory here), grants it and leaves the owner's notice row, a coding call
// switches coding sessions on, and a routine run is never offered the tool.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const tool = "agentpier_project";
const userAccess = {
  mode: "own",
  members: [{ userId: "user-fixture", level: "extended" }],
  released: [],
};
const routineMark = "PROJECT_ROUTINE_CONTRACT";

test(
  "pinned Gateway: an own agent creates a project and switches its coding sessions through the compiled tool",
  {
    skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
    timeout: contractTimeout(240000),
  },
  async (t) => {
    // The model calls the tool with the arguments registered for `[cmd:<label>]`.
    const calls = new Map();
    const h = await compiledShell(t, installed, {
      prefix: "project-contract-",
      tool: (input) => {
        const text = JSON.stringify(input.messages);
        const label = [...calls.keys()].find((l) => text.includes(`[cmd:${l}]`));
        return label ? { name: tool, arguments: calls.get(label) } : null;
      },
    });
    const { store, workflows, runtime, config } = h;
    // One owner turn that calls the tool with `args`; returns the settled turn.
    const call = async (label, args) => {
      calls.set(label, args);
      const turn = await h.settle(await h.send(owner, label, "unused"));
      t.diagnostic(`${label}=${turn.result?.slice(0, 600)}`);
      assert.equal(turn.status, "ok", `${label} turn`);
      assert.ok(turn.result, `${label} returned a tool result`);
      return { ...turn, json: JSON.parse(turn.result) };
    };

    // The owner's default folder and the project registry live in the test's data
    // directory, with the simulated owner's home: none of the developer's.
    const parent = h.at("projects");
    fs.mkdirSync(parent);
    const memory = new ProjectMemory({ dataDir: h.at("memory"), home: h.owner.home });
    t.after(() => memory.close());
    Object.assign(workflows.s, {
      memory,
      preferences: { get: () => ({ defaultCwd: parent }) },
      pipelineDefinitions: { listPipelines: () => [] },
      accounts: { list: () => [] },
      providerConnections: { list: () => [] },
      secrets: { list: () => [] },
      sshAccesses: { list: () => [] },
      nonoSandbox: { executable: () => null },
      requests: { listAll: () => [] },
    });

    const owner = h.create("Owner");
    const user = h.create("User");
    store.changeUserAgent(user.id, { userAccess });
    await runtime.start();
    for (const agent of [owner, user]) await config.apply(agent.id);

    // 1. The compiled entries: the own agent holds the tool, the user agent denies it.
    const entries = (await h.running()).agents.entries;
    const entryOf = (agent) => entries[store.getAssistant(agent.id).runtimeAgentId];
    assert.ok(entryOf(owner).tools.allow.includes(tool), "own agent holds the tool");
    assert.ok(!entryOf(user).tools.allow.includes(tool), "user agent never holds it");
    assert.ok(entryOf(user).tools.deny.includes(tool));
    const instructions = fs.readFileSync(
      path.join(runtime.paths.workspaces, owner.id, "AGENTS.md"),
      "utf8",
    );
    assert.match(instructions, /\n## Projects\n/);

    // 2. An owner turn's create call reaches AgentProjects through the bridge.
    const created = await call("create", { action: "create", name: "contract-shop" });
    const projectId = created.json.projectId;
    const folder = path.join(parent, "contract-shop");
    assert.equal(typeof projectId, "string");
    assert.deepEqual(created.json, {
      projectId,
      name: "contract-shop",
      path: folder,
      coding: false,
    });
    // The Gateway offers the tool with its whole description.
    const offered = h.model.requests
      .find((r) => JSON.stringify(r.messages).includes("[cmd:create]"))
      ?.tools?.find((d) => d.function.name === tool);
    assert.equal(
      offered?.function.description,
      projectDefinition.project.description,
      "description intact",
    );
    // The folder in the default folder, a Git repository, registered and granted.
    assert.ok(fs.statSync(folder).isDirectory());
    assert.ok(fs.existsSync(path.join(folder, ".git")), "Git initialized");
    assert.equal(memory.project(projectId).cwd, folder);
    const granted = workflows.access.get(owner.id);
    assert.equal(granted.projectFiles[projectId], "write", "folder write grant");
    assert.ok(!granted.sessionProjectIds.includes(projectId), "coding still off");
    // The owner's notice: one settled agent_project row in the agent's chat.
    const projectRows = () =>
      workflows.store.list(owner.id).filter((a) => a.payload?.action === "agent_project");
    const [createRow] = projectRows();
    assert.equal(projectRows().length, 1, "one notice row");
    assert.equal(createRow.state, "completed");
    assert.equal(createRow.payload.change, "create");
    assert.equal(createRow.payload.projectId, projectId);
    assert.equal(createRow.payload.path, folder);
    assert.ok(createRow.chatNotes?.result, "the row carries its chat note");

    // 3. A coding call switches coding sessions on for the created project.
    const coding = await call("coding", { action: "coding", projectId, enabled: true });
    assert.deepEqual(coding.json, { projectId, coding: true });
    const switched = workflows.access.get(owner.id);
    assert.ok(switched.projectIds.includes(projectId), "project granted");
    assert.ok(switched.sessionProjectIds.includes(projectId), "coding sessions on");
    assert.equal(switched.projectFiles[projectId], "write");
    const changes = projectRows().map((a) => [a.payload.change, a.payload.coding]);
    assert.equal(changes.length, 2, "a notice row for the switch");
    assert.ok(changes.some(([change, on]) => change === "coding" && on === true));

    // 4. A routine run's toolsAllow never admits the tool.
    const session = await createGatewaySession(runtime.client, {
      agentId: store.getAssistant(owner.id).runtimeAgentId,
      label: "Routine target",
    });
    const job = await runtime.client.call("cron.add", {
      name: "Project routine",
      agentId: store.getAssistant(owner.id).runtimeAgentId,
      enabled: false,
      deleteAfterRun: false,
      schedule: { kind: "every", everyMs: 3600000 },
      wakeMode: "now",
      sessionTarget: "current",
      sessionKey: session.key,
      payload: {
        kind: "agentTurn",
        message: `Start a project. ${routineMark}`,
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
    assert.ok(!routineOffered.includes(tool), "a routine is never offered the tool");
  },
);
