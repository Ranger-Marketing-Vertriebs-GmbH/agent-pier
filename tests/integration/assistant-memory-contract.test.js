import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtime-config.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeMemory } from "../../server/features/assistants/native-memory.js";
import { assistantMemoryModel } from "../helpers/assistant-memory-model.js";

const installed = process.env.AGENTPIER_ASSISTANT_MEMORY_RUNTIME;
const execute = promisify(execFile);

async function fixture(t) {
  assert.ok(path.isAbsolute(installed));
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(installed, "app/node_modules/openclaw/package.json"),
        "utf8",
      ),
    ).version,
    runtimeManifest.version,
  );
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-memory-contract-"));
  const descriptor = {
    version: runtimeManifest.version,
    nodePath: path.join(installed, "node/bin/node"),
    entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
  };
  const runtime = new RuntimeSupervisor({ dataDir, install: async () => descriptor });
  const store = new AssistantStore({ dataDir });
  let model;
  t.after(async () => {
    try {
      await runtime.close();
      store.close();
      await model?.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  model = await assistantMemoryModel();
  const plugin = provisionTeamPlugin({
    paths: runtime.paths,
    runtimeVersion: descriptor.version,
  });
  runtime.teamConfiguration = async () => ({
    directory: plugin.directory,
    connection: { url: "http://127.0.0.1:1", token: "memory-fixture" },
    hostMaxConcurrent: 4,
    native: { token: "memory-fixture" },
    profiles: store.listAssistants(),
  });
  await runtime.start();
  const managed = (await runtime.client.call("config.get", {})).config;
  assert.equal(managed.memory.search.provider, "none");
  assert.deepEqual(managed.memory.search.sources, ["memory"]);
  assert.equal(managed.memory.search.rememberAcrossConversations, false);
  const models = {
    resolve: ({ modelId }) => ({
      providerId: "memory-fixture",
      modelRef: `memory-fixture/${modelId}`,
      provider: {
        baseUrl: model.url,
        api: "openai-completions",
        apiKey: "memory-fixture",
        models: ["model-a", "model-b"].map((id) => ({
          id,
          name: id,
          contextWindow: 32768,
          maxTokens: 4096,
        })),
      },
      release() {},
    }),
  };
  const config = new AssistantConfig({
    client: runtime.client,
    store,
    models,
    workspaces: runtime.paths.workspaces,
  });
  config.nativeReady = () => true;
  const assistants = {
    store,
    runtime,
    config,
    admit: (fn) => Promise.resolve().then(fn),
    requireReady: () => assert.ok(runtime.client.ready),
    changed() {},
  };
  const memory = new NativeMemory(assistants);
  async function create(name) {
    let agent = store.createAssistant({
      name,
      instructions: "Search memory for quartz, then reply briefly.",
      model: { connectionId: "memory-fixture", modelId: "model-a" },
    });
    agent = store.updateAssistant(
      agent.id,
      { capabilities: { memory: true, reminders: false } },
      agent.revision,
    );
    await config.apply(agent.id);
    return agent;
  }
  async function save(agent, content) {
    const previous = await memory.read(agent.id, "MEMORY.md");
    return memory.write(agent.id, {
      name: "MEMORY.md",
      content,
      ...(previous.missing ? { expectedMissing: true } : { expectedHash: previous.hash }),
    });
  }
  async function restart({ reindex = [] } = {}) {
    const oldPid = runtime.child.pid;
    await runtime.stop();
    for (const agent of reindex) {
      const { stdout } = await execute(
        descriptor.nodePath,
        [
          descriptor.entryPath,
          "memory",
          "index",
          "--force",
          "--agent",
          agent.runtimeAgentId,
        ],
        {
          cwd: runtime.paths.root,
          env: runtimeEnvironment(runtime.paths, descriptor.nodePath, "memory-fixture"),
          timeout: 60000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.match(stdout, /indexed|nothing was indexed/i);
    }
    await runtime.start();
    assert.notEqual(runtime.child.pid, oldPid);
    config.client = runtime.client;
    config.reset();
  }
  async function turn(agent, expectedModel, present, absent) {
    const offset = model.requests.length;
    const session = await runtime.client.call("sessions.create", {
      agentId: agent.runtimeAgentId,
    });
    const sent = await runtime.client.call("sessions.send", {
      key: session.key,
      message: "Search your saved quartz note.",
      idempotencyKey: crypto.randomUUID(),
    });
    const done = await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 45000 },
      { timeoutMs: 50000 },
    );
    assert.equal(done.status, "ok", JSON.stringify(done));
    assert.ok(done.terminalReceipt?.successfulToolNames.includes("memory_search"));
    const calls = model.requests.slice(offset).filter((r) => r.tools?.length);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((r) => r.model === expectedModel));
    const result = JSON.stringify(calls[1].messages.filter((m) => m.role === "tool"));
    assert.ok(result.includes(present), "native search returns the agent's note");
    assert.equal(
      result.includes(absent),
      false,
      "native search isolates the other agent",
    );
    return session.key;
  }
  return { runtime, store, config, memory, model, create, save, restart, turn };
}

test(
  "native memory clears and removes indexed notes across re-index and restart",
  { skip: !installed, timeout: 240000 },
  async (t) => {
    const f = await fixture(t);
    const agent = await f.create("Memory deletion contract");
    const workspace = path.join(f.runtime.paths.workspaces, agent.id);
    const note = path.join(workspace, "memory", "qualification.md");
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, "Quartz removable note: ORCHIDREMOVALTOKEN.\n");
    await f.save(agent, "Quartz saved note: COBALTCLEARTOKEN.\n");
    await f.restart({ reindex: [agent] });
    for (const token of ["COBALTCLEARTOKEN", "ORCHIDREMOVALTOKEN"])
      assert.ok((await f.memory.search(agent.id, token)).results.length > 0);

    const cleared = await f.save(agent, "");
    assert.equal(cleared.content, "");
    const deadline = Date.now() + 15000;
    let results;
    do {
      results = (await f.memory.search(agent.id, "COBALTCLEARTOKEN")).results;
      if (!results.length) break;
      await delay(100);
    } while (Date.now() < deadline);
    assert.deepEqual(results, [], "native watcher/search refresh clears the live index");
    assert.ok(
      (await f.memory.search(agent.id, "ORCHIDREMOVALTOKEN")).results.length,
      "clearing one file preserves the separate workspace note",
    );
    fs.unlinkSync(note);
    await f.restart({ reindex: [agent] });
    assert.equal((await f.memory.read(agent.id, "MEMORY.md")).content, "");
    for (const token of ["COBALTCLEARTOKEN", "ORCHIDREMOVALTOKEN"])
      assert.deepEqual((await f.memory.search(agent.id, token)).results, []);

    // A replacement must be indexed, without bringing deleted chunks back.
    fs.writeFileSync(note, "Quartz replacement note: AMBERREPLACEMENTTOKEN.\n");
    await f.restart({ reindex: [agent] });
    assert.ok((await f.memory.search(agent.id, "AMBERREPLACEMENTTOKEN")).results.length);
    for (const token of ["COBALTCLEARTOKEN", "ORCHIDREMOVALTOKEN"])
      assert.deepEqual((await f.memory.search(agent.id, token)).results, []);
    t.diagnostic(
      "Live search dropped cleared content; native force re-index removed deleted chunks and indexed replacement content.",
    );
  },
);

test(
  "native memory persists across configured model switches and stays agent scoped",
  { skip: !installed, timeout: 240000 },
  async (t) => {
    const f = await fixture(t);
    const alpha = await f.create("Alpha memory contract");
    const beta = await f.create("Beta memory contract");
    const alphaText = "Quartz private alpha note: ALPHAMEMORYTOKEN.\n";
    const betaText = "Quartz private beta note: BETAMEMORYTOKEN.\n";
    await f.save(alpha, alphaText);
    await f.save(beta, betaText);
    await f.restart({ reindex: [alpha, beta] });
    await f.memory.read(alpha.id, "MEMORY.md");
    const first = await f.turn(alpha, "model-a", "ALPHAMEMORYTOKEN", "BETAMEMORYTOKEN");
    const current = f.store.getAssistant(alpha.id);
    f.store.updateAssistant(
      alpha.id,
      { model: { connectionId: "memory-fixture", modelId: "model-b" } },
      current.revision,
    );
    await f.config.apply(alpha.id);
    const second = await f.turn(alpha, "model-b", "ALPHAMEMORYTOKEN", "BETAMEMORYTOKEN");
    assert.notEqual(first, second, "fresh conversation proves file-based recall");
    await f.restart();
    assert.equal((await f.memory.read(alpha.id, "MEMORY.md")).content, alphaText);
    assert.equal((await f.memory.read(beta.id, "MEMORY.md")).content, betaText);
    await f.turn(alpha, "model-b", "ALPHAMEMORYTOKEN", "BETAMEMORYTOKEN");
    await f.turn(beta, "model-a", "BETAMEMORYTOKEN", "ALPHAMEMORYTOKEN");
    assert.deepEqual((await f.memory.search(alpha.id, "BETAMEMORYTOKEN")).results, []);
    assert.deepEqual((await f.memory.search(beta.id, "ALPHAMEMORYTOKEN")).results, []);
    t.diagnostic(
      "Model A to B persisted across restart; both native memory tool loops remained agent scoped.",
    );
  },
);
