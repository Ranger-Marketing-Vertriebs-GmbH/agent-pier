import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "./process-guard.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtime-config.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { proactivityModel } from "./assistant-proactivity-model.js";
import { stepPolicyBridge } from "./assistant-step-policy-bridge.js";

export const installed = process.env.AGENTPIER_PROACTIVITY_CONTRACT_RUNTIME;
export const dreamingKey = "memory-core:memory-dreaming-promotion";
/** The section AgentPier compiles when the owner switches dreaming on. */
export const dreamingOn = {
  enabled: true,
  frequency: "0 3 * * *",
  timezone: "Europe/Berlin",
  storage: { mode: "separate" },
};
const modelIds = ["fixture-model", "orchid-model", "fern-model", "task-model"];

/** Every regular file below `dir` as { relative path: content }. */
export function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile())
        files[path.relative(dir, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

/** The files `after` adds or changes compared with `before`. */
export const changed = (before, after) =>
  Object.fromEntries(
    Object.entries(after).filter(([name, text]) => before[name] !== text),
  );

/**
 * A compiled native team Gateway (memory-core) with fixture agents on one model
 * double; each agent may run on its own model id so a dreaming call is attributable.
 * The data directory is resolved (`resolve: false` keeps os.tmpdir() as given, which
 * on macOS sits behind the /var -> /private/var symlink).
 */
export async function nativeFixture(t, { resolve = true } = {}) {
  assert.ok(path.isAbsolute(installed));
  const base = os.tmpdir();
  const dataDir = fs.mkdtempSync(
    path.join(resolve ? fs.realpathSync(base) : base, "assistant-dreaming-contract-"),
  );
  const descriptor = {
    version: runtimeManifest.version,
    nodePath: path.join(installed, "node/bin/node"),
    entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
  };
  const runtime = new RuntimeSupervisor({ dataDir, install: async () => descriptor });
  const store = new AssistantStore({ dataDir });
  const model = await proactivityModel();
  const bridge = await stepPolicyBridge("dreaming-fixture");
  t.after(async () => {
    try {
      await runtime.close();
      store.close();
      await model.close();
      await bridge.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  const plugin = provisionTeamPlugin({
    paths: runtime.paths,
    runtimeVersion: descriptor.version,
  });
  runtime.teamConfiguration = async () => ({
    directory: plugin.directory,
    connection: bridge.connection,
    hostMaxConcurrent: 4,
    native: { token: "dreaming-fixture" },
    profiles: store.listAssistants(),
  });
  await runtime.start();
  const config = new AssistantConfig({
    client: runtime.client,
    store,
    models: {
      resolve: ({ modelId }) => ({
        providerId: "fixture",
        modelRef: `fixture/${modelId}`,
        provider: {
          baseUrl: model.url,
          api: "openai-completions",
          apiKey: "fixture-key",
          models: modelIds.map((id) => ({
            id,
            name: id,
            contextWindow: 32768,
            maxTokens: 4096,
          })),
        },
        release() {},
      }),
    },
    workspaces: runtime.paths.workspaces,
  });
  config.nativeReady = () => true;
  const call = (method, params, timeoutMs = 60000) =>
    runtime.client.call(method, params, { timeoutMs });
  async function create(name, capabilities, modelId = "fixture-model") {
    const agent = store.createAssistant({
      name,
      instructions: "",
      model: { connectionId: "fixture", modelId },
    });
    store.updateAssistant(agent.id, { capabilities }, agent.revision);
    await config.apply(agent.id);
    return store.getAssistant(agent.id);
  }
  // A conversation as AgentPier opens one; labels are unique per Gateway. The first
  // call after a live apply waits for the plugin reload, so it gets more time.
  async function open(
    agent,
    label = `AgentPier ${agent.id} chat ${crypto.randomUUID()}`,
  ) {
    return (await call("sessions.create", { agentId: agent.runtimeAgentId, label })).key;
  }
  async function send(key, text) {
    const sent = await call("sessions.send", {
      key,
      message: text,
      idempotencyKey: crypto.randomUUID(),
    });
    return sent.runId;
  }
  const wait = (runId, ms = 60000) =>
    call("agent.wait", { runId, timeoutMs: ms }, ms + 5000);
  async function turn(agent, text, label) {
    const key = await open(agent, label);
    const done = await wait(await send(key, text));
    assert.equal(done.status, "ok", JSON.stringify(done));
    return key;
  }
  const effective = async () => (await call("config.get", {})).config;
  async function patch(raw) {
    const base = await call("config.get", {});
    await call("config.patch", { baseHash: base.hash, raw: JSON.stringify(raw) });
  }
  const dreaming = (section) =>
    patch({ plugins: { entries: { "memory-core": { config: { dreaming: section } } } } });
  const dreamingJobs = async () =>
    (await call("cron.list", { includeDisabled: true, limit: 200 })).jobs.filter(
      (j) => j.declarationKey === dreamingKey,
    );
  async function until(probe, ms, what) {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await delay(500);
    }
  }
  const job = () =>
    until(async () => (await dreamingJobs())[0], 30000, "the dreaming job");
  // A finished cron run; the narratives it detaches are awaited by `settle`.
  async function finished(id, after = 0, ms = 120000) {
    return until(
      async () =>
        (await call("cron.runs", { id, limit: 20 })).entries.find(
          (r) => r.action === "finished" && (r.ts ?? r.runAtMs ?? 0) >= after,
        ),
      ms,
      "a finished dreaming run",
    );
  }
  async function forceRun(id) {
    const started = Date.now();
    await call("cron.run", { id, mode: "force" });
    return finished(id, started);
  }
  // Waits until each of `files` (paths in a workspace, e.g. a diary) exists and the
  // model double then saw no request for `quietMs` (detached narratives).
  async function settle({ files = [], quietMs = 4000, ms = 90000 } = {}) {
    const deadline = Date.now() + ms;
    for (const file of files)
      await until(() => fs.existsSync(file), Math.max(0, deadline - Date.now()), file);
    let count = -1;
    while (Date.now() < deadline) {
      if (count === model.requests.length) return;
      count = model.requests.length;
      await delay(quietMs);
    }
  }
  const workspace = (agent) => path.join(runtime.paths.workspaces, agent.id);
  const diary = (agent) => path.join(workspace(agent), "DREAMS.md");
  const corpus = (agent) =>
    Object.values(snapshot(path.join(workspace(agent), "memory", ".dreams"))).join("\n");
  // memory-core keeps its dreaming state in the Gateway's SQLite plugin state, keyed
  // by sha256(workspace path); `value.key` is the logical key (state of 2026.10.7).
  function pluginState(namespace, agent) {
    const db = new DatabaseSync(
      path.join(runtime.paths.state, "state", "openclaw.sqlite"),
      {
        readOnly: true,
      },
    );
    try {
      return db
        .prepare(
          "SELECT value_json FROM plugin_state_entries WHERE plugin_id='memory-core' AND namespace=?",
        )
        .all(namespace)
        .map((row) => JSON.parse(row.value_json))
        .filter((v) => !agent || v.workspaceDir === workspace(agent));
    } finally {
      db.close();
    }
  }
  const ingestion = (agent) => ({
    files: pluginState("dreaming-session-ingestion-files", agent).map((v) => v.key),
    seen: pluginState("dreaming-session-ingestion-seen", agent).map((v) => v.key),
  });
  // The runtime's own CLI against this Gateway's state (as `openclaw` would run).
  const cli = async (args) =>
    (
      await promisify(execFile)(descriptor.nodePath, [descriptor.entryPath, ...args], {
        cwd: runtime.paths.root,
        env: runtimeEnvironment(runtime.paths, descriptor.nodePath),
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  const sessions = async (agent) =>
    (await call("sessions.list", { agentId: agent.runtimeAgentId, limit: 200 })).sessions;
  return {
    dataDir,
    runtime,
    store,
    config,
    model,
    bridge,
    call,
    create,
    open,
    send,
    wait,
    turn,
    effective,
    patch,
    dreaming,
    dreamingJobs,
    job,
    finished,
    forceRun,
    settle,
    until,
    workspace,
    diary,
    corpus,
    sessions,
    pluginState,
    ingestion,
    cli,
  };
}
