import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { AssistantMaintenance } from "../../server/features/assistants/assistant-maintenance.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { runtimeFor } from "../../server/features/assistants/runtimes/runtime-for.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";
import { fakeAccess, startFakeCodex } from "../helpers/fake-chatgpt.js";
import { startChatgptInterceptor } from "../helpers/chatgpt-interceptor.js";
import { testPhases } from "../helpers/test-phases.js";

// AGENTPIER-487: after the update 2026.11.3 -> 2026.11.6 every turn of an agent on an
// AgentPier-held ChatGPT login failed in milliseconds ("No route-compatible
// authentication source is configured for openai", or "Unknown model") although the
// login stayed connected. The model, GPT-6.2-Astra, is known only from the account's
// model discovery, whose per-agent result OpenClaw 2026.11.6 no longer has after the
// migration and does not rediscover for a turn. Manual, like
// assistant-runtime-cross-version.test.js: it needs two immutable installations.
// Synthetic tokens only, and nothing leaves the host: chatgpt.com is a local fake
// Codex backend behind an intercepting proxy that refuses every other host. OpenClaw's
// guarded fetches (model discovery) pin DNS and ignore HTTP(S)_PROXY, so the Gateway
// also routes through it as its managed proxy (OPENCLAW_PROXY_URL).
const previousRoot = process.env.AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME;
const candidateRoot = process.env.AGENTPIER_ASSISTANT_UPDATE_RUNTIME;
const profileId = "openai:cross-version@example.invalid";
// Listed only by the account's model discovery, never by a bundled catalog.
const modelId = "gpt-6.2-astra";

function descriptor(root) {
  const manifest = readJSON(path.join(root, "app/node_modules/openclaw/package.json"));
  return {
    version: manifest.version,
    nodePath: path.join(root, "node/bin/node"),
    entryPath: path.join(root, "app/node_modules/openclaw/openclaw.mjs"),
  };
}

function useProxy(t, url) {
  const proxies = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];
  const names = [...proxies, "NO_PROXY", "no_proxy"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const name of names) delete process.env[name];
  for (const name of proxies) process.env[name] = url;
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
}

test(
  "native cross-version: an agent on a ChatGPT login AgentPier holds runs turns after the runtime update",
  { skip: !previousRoot || !candidateRoot, timeout: 400000 },
  async (t) => {
    const candidate = descriptor(candidateRoot);
    const previous = {
      ...descriptor(previousRoot),
      ...(previousRoot === candidateRoot && { version: "pre-update" }),
    };
    t.diagnostic(`${previous.version} -> ${candidate.version}`);
    const phase = testPhases(t);
    const codex = await startFakeCodex({ models: [modelId] });
    const chatgpt = await startChatgptInterceptor({ target: new URL(codex.url).port });
    useProxy(t, chatgpt.url);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-access-version-"));
    const store = new AssistantStore({ dataDir });
    let runtime;
    t.after(async () => {
      try {
        await runtime?.close();
      } finally {
        store.close();
        await chatgpt.close();
        await codex.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => readJSON(path.join(runtime.paths.root, "runtime.json")),
    });
    writePrivate(path.join(runtime.paths.root, "runtime.json"), previous);
    // Only the Gateway trusts the interceptor's CA and routes through it.
    const spawn = runtime.spawn;
    runtime.spawn = (command, args, options) =>
      spawn(command, args, {
        ...options,
        env: {
          ...options.env,
          NODE_EXTRA_CA_CERTS: chatgpt.caFile,
          OPENCLAW_PROXY_URL: chatgpt.url,
        },
      });
    const assistants = {
      store,
      ledger: new RequestLedger(store.db),
      runtime,
      locks: new Map(),
      maintenance: false,
      changed() {},
      admit: (fn) => Promise.resolve().then(fn),
      requireReady() {
        assert.ok(runtime.client?.ready);
      },
      reconcile: async () => {},
    };
    runtime.maintenance = () => assistants.maintenance;
    // The host's team plugin, as every AgentPier start compiles it (plugins.allow).
    runtime.teamConfiguration = async (installed) => ({
      directory: provisionTeamPlugin({
        paths: runtime.paths,
        runtimeVersion: installed.version,
      }).directory,
      connection: { url: "http://127.0.0.1:1", token: "fixture" },
      native: { token: "fixture-webhook" },
      hostMaxConcurrent: 4,
      profiles: store.listAssistants(),
    });
    const model = { connectionId: "chatgpt-account", modelId };
    const first = store.createAssistant({ name: "ChatGPT", model });
    phase(`start ${previous.version}`);
    await runtime.start();
    const identity = { accountId: "acct", email: "cross-version@example.invalid" };
    const expires = Date.now() + 3 * 3600_000;
    const access = fakeAccess({ ...identity, expires });
    phase("sign in");
    await runtimeFor(null, runtime).models.writeAccess({
      profileId,
      credential: { access, expires, ...identity },
    });
    // Agents on that login exactly as AssistantModelAccounts.resolve leases it.
    assistants.config = new AssistantConfig({
      runtime,
      store,
      workspaces: runtime.paths.workspaces,
      models: {
        resolve: () => ({
          modelRef: `openai/${modelId}@${profileId}`,
          agentRuntime: { model: `openai/${modelId}`, id: "openclaw" },
          chatgpt: { profileId, modelId, holder: "agentpier" },
          display: { connection: "ChatGPT", model: modelId },
          release() {},
        }),
      },
    });
    assistants.config.nativeReady = () => true;
    await assistants.config.apply(first.id);

    // Whether the agent's model list offers the model; never starts a discovery.
    async function offered(agentId) {
      for (let tries = 0; tries < 60; tries++) {
        const listed = await runtime.client.call(
          "models.list",
          { agentId, provider: "openai", view: "all" },
          { timeoutMs: 60000 },
        );
        if (listed.models?.find((row) => row.id === modelId)?.available) return true;
        await delay(1000);
      }
      return false;
    }
    // Waits (bounded) until an account discovery reached the backend after request
    // number `from` and OpenClaw had a moment to keep its result; a runtime that never
    // discovers is left to fail its turn.
    async function discoveredSince(from) {
      for (let tries = 0; tries < 60; tries++) {
        const asked = codex.requests.slice(from);
        if (asked.some((r) => r.url.startsWith("/backend-api/codex/models"))) {
          await delay(2000);
          return;
        }
        await delay(1000);
      }
      t.diagnostic(`no account discovery after request ${from}`);
    }
    // One turn reached the fake backend on the discovered model with the login's token.
    async function answered(agentId, label) {
      const from = codex.requests.length;
      const session = await createGatewaySession(runtime.client, { agentId, label });
      const sent = await runtime.client.call("sessions.send", {
        key: session.key,
        message: "Hello.",
        idempotencyKey: label,
      });
      const done = await runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 90000 },
        { timeoutMs: 95000 },
      );
      t.diagnostic(`${label} wait=${JSON.stringify(done)}`);
      const asked = codex.requests
        .slice(from)
        .filter((r) => r.url === "/backend-api/codex/responses");
      assert.equal(done.status, "ok", `${label}: ${done.error}`);
      assert.ok(asked.length > 0, `${label} reached the ChatGPT backend`);
      for (const request of asked)
        assert.equal(request.headers.authorization, `Bearer ${access}`);
      assert.equal(done.terminalReceipt?.effective?.model, modelId);
      assert.match(done.terminalReply?.text ?? "", /^CODEX:/);
    }

    const before = store.getAssistant(first.id).runtimeAgentId;
    phase("turn on the previous runtime");
    assert.ok(
      await offered(before),
      "the previous runtime discovered the account's model",
    );
    await answered(before, "before-update");

    // Activate the candidate through the update path (snapshot, Doctor, validate).
    const updates = new RuntimeUpdates({
      dataDir,
      runtime,
      maintenance: new AssistantMaintenance({
        assistants,
        assistantRuntime: runtime,
        assistantChannels: {
          pause: async () => {},
          resume() {},
          store: { list: () => [] },
        },
        assistantReminders: {
          webhook: { jobs: new Set() },
          hasRunning: async () => false,
        },
      }),
      stage: async () => candidate,
    });
    phase("stage");
    await updates.stage();
    phase(`activate ${candidate.version}`);
    const activated = codex.requests.length;
    await updates.activate();
    assert.equal(updates.status().phase, "complete");
    assert.equal(runtime.status().version, candidate.version);

    phase("turn on the updated runtime");
    // No model list read here: a read would itself start a discovery. The owner's
    // agents had their first turn right after the update.
    await discoveredSince(activated);
    await answered(before, "after-update");

    phase("a new agent on the updated runtime");
    const second = store.createAssistant({ name: "ChatGPT two", model });
    const created = codex.requests.length;
    await assistants.config.apply(second.id);
    await discoveredSince(created);
    await answered(store.getAssistant(second.id).runtimeAgentId, "new-agent");

    // OpenClaw's Doctor read the configuration compiled for the candidate: no key the
    // candidate refuses left it on its default agent directories.
    const log = fs.readFileSync(
      path.join(runtime.paths.logs, "gateway-console.log"),
      "utf8",
    );
    assert.doesNotMatch(log, /Config unavailable|Invalid config/);
    // Every other host the Gateway asked for was refused.
    t.diagnostic(`proxy hosts=${JSON.stringify([...new Set(chatgpt.tunnels)])}`);
  },
);
