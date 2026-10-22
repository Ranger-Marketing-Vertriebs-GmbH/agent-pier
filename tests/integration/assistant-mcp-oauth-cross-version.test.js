import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { AssistantMaintenance } from "../../server/features/assistants/assistant-maintenance.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtime-config.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import {
  defaultBusyRetryDelaysMs,
  leaseLocked,
  parseLoginOutput,
} from "../../server/features/mcp-servers/openclaw-mcp-cli.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import {
  authorize,
  exchanged,
  oauthMcpServer,
} from "../helpers/mcp-oauth-test-server.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

// An MCP OAuth login made on the previous runtime keeps working after a runtime
// update: the activation carries the stored client and tokens over, the candidate
// refreshes them unattended, and its CLI output stays parseable. Manual, like
// assistant-runtime-cross-version.test.js: it needs two immutable installations.
// The same installation for both runs the update path without a version change.
const previousRoot = process.env.AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME;
const candidateRoot = process.env.AGENTPIER_ASSISTANT_UPDATE_RUNTIME;
const sdkWarning = "stored OAuth tokens have no 'issuer'";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function descriptor(root) {
  const manifest = readJSON(path.join(root, "app/node_modules/openclaw/package.json"));
  return {
    version: manifest.version,
    nodePath: path.join(root, "node/bin/node"),
    entryPath: path.join(root, "app/node_modules/openclaw/openclaw.mjs"),
  };
}

async function holdPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

test(
  "native cross-version MCP OAuth login refreshes on the updated runtime",
  { skip: !previousRoot || !candidateRoot, timeout: 300000 },
  async (t) => {
    const candidate = descriptor(candidateRoot);
    // One installation for both: a distinct selection makes the activation real.
    const previous = {
      ...descriptor(previousRoot),
      ...(previousRoot === candidateRoot && { version: "pre-update" }),
    };
    t.diagnostic(`${previous.version} -> ${candidate.version}`);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-oauth-version-"));
    const store = new AssistantStore({ dataDir });
    const tool = { name: "none", arguments: {} };
    const model = await assistantModelServer({ tool });
    const oauth = await oauthMcpServer();
    const held = await holdPort();
    let runtime;
    t.after(async () => {
      try {
        await runtime?.close();
      } finally {
        store.close();
        await model.close();
        await oauth.close();
        await held.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => readJSON(path.join(runtime.paths.root, "runtime.json")),
    });
    writePrivate(path.join(runtime.paths.root, "runtime.json"), previous);
    const agent = store.createAssistant({
      name: "Bound",
      instructions: "Use the tool.",
      model: { connectionId: "fixture", modelId: "fixture-model" },
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
    await runtime.start();
    const config = new AssistantConfig({
      store,
      workspaces: runtime.paths.workspaces,
      client: { call: (...args) => runtime.client.call(...args) },
      hostCapacity: () => 4,
      models: {
        resolve: () => ({
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
      },
    });
    config.nativeReady = () => true;
    config.writeGuard = () => false;
    assistants.config = config;
    await config.apply(agent.id);

    // The CLI of whichever runtime is selected, in the Gateway's own environment.
    const selected = () => readJSON(path.join(runtime.paths.root, "runtime.json"));
    function cliOnce(args) {
      const { nodePath, entryPath } = selected();
      const env = runtimeEnvironment(runtime.paths, nodePath, {});
      return new Promise((resolve) => {
        execFile(
          nodePath,
          [entryPath, ...args],
          { env, cwd: runtime.paths.root, timeout: 90000 },
          (error, stdout, stderr) => {
            const run = { code: error ? (error.code ?? null) : 0, stdout, stderr };
            t.diagnostic(`cli ${args.join(" ")} -> ${JSON.stringify(run)}`);
            resolve(run);
          },
        );
      });
    }
    async function cli(args) {
      for (let attempt = 0; ; attempt++) {
        const run = await cliOnce(args);
        if (run.code === 0 || !leaseLocked(run.stderr)) return run;
        if (attempt >= defaultBusyRetryDelaysMs.length) return run;
        await sleep(defaultBusyRetryDelaysMs[attempt]);
      }
    }
    // `mcp status --json` prints nothing but the JSON document on stdout.
    async function authStatus() {
      const run = await cli(["mcp", "status", "--json"]);
      assert.equal(run.code, 0, run.stderr);
      assert.ok(!run.stdout.includes("[mcp-sdk]"), run.stdout);
      return JSON.parse(run.stdout).servers.find((s) => s.name === "docs").authStatus;
    }
    async function turn(call, label) {
      Object.assign(tool, call ?? { name: "none", arguments: {} });
      const from = model.requests.length;
      const session = await createGatewaySession(runtime.client, {
        agentId: agent.runtimeAgentId,
        label,
      });
      const sent = await runtime.client.call("sessions.send", {
        key: session.key,
        message: "Use the tool.",
        idempotencyKey: label,
      });
      const done = await runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 60000 },
        { timeoutMs: 65000 },
      );
      assert.equal(done.status, "ok", label);
      const requests = model.requests.slice(from);
      const offered = (requests[0]?.tools ?? [])
        .map((d) => d.function.name)
        .filter((n) => n.includes("__"));
      const result = requests
        .flatMap((r) => r.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content))
        .at(-1);
      t.diagnostic(`${label} offered=${JSON.stringify(offered)} result=${result}`);
      return { offered, result };
    }
    const grants = () => oauth.log.filter((e) => e.grant).map((e) => e.grant);
    const sdkWarnings = () =>
      fs
        .readFileSync(path.join(runtime.paths.logs, "gateway-console.log"), "utf8")
        .split(sdkWarning).length - 1;

    // Bind a Streamable HTTP OAuth server to the agent, as AgentPier compiles it.
    const redirectUrl = `http://127.0.0.1:${held.port}/api/mcp-servers/oauth/callback`;
    // A Gateway start compiles `mcp` and the allow lists from AgentPier's own store,
    // which this test bypasses: the binding is applied again after each start.
    const bind = () =>
      patchConfig(runtime.client, (current) => {
        const own = (list) => list.filter((n) => n !== "bundle-mcp" && !n.includes("__"));
        const entry = current.agents.entries[agent.runtimeAgentId];
        return {
          patch: {
            mcp: {
              servers: {
                docs: {
                  url: oauth.url,
                  transport: "streamable-http",
                  auth: "oauth",
                  oauth: { redirectUrl },
                },
              },
            },
            tools: { allow: [...own(current.tools.allow), "bundle-mcp"] },
            agents: {
              entries: {
                [agent.runtimeAgentId]: {
                  tools: { allow: [...own(entry.tools.allow), "docs__*"] },
                },
              },
            },
          },
          replacePaths: [
            "tools.allow",
            `agents.entries.${agent.runtimeAgentId}.tools.allow`,
          ],
        };
      });
    await bind();

    // Log in with the previous runtime's CLI (redirect port held: URL, then --code).
    let authorizationUrl;
    for (let attempt = 1; !authorizationUrl; attempt++) {
      const run = await cli(["mcp", "login", "docs"]);
      assert.equal(run.code, 0, run.stderr);
      const parsed = parseLoginOutput(run.stdout, "docs");
      if (parsed?.redacted && attempt < 3) continue;
      assert.ok(parsed?.authorizationUrl, run.stdout);
      authorizationUrl = new URL(parsed.authorizationUrl);
    }
    const callback = await authorize(oauth, authorizationUrl, redirectUrl);
    const done = await cli([
      "mcp",
      "login",
      "docs",
      "--code",
      callback.searchParams.get("code"),
    ]);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.stdout, 'MCP OAuth credentials saved for "docs".\n');
    exchanged(oauth);
    assert.equal((await authStatus()).state, "authorized");
    const call = { name: "docs__echo", arguments: { text: "before-update" } };
    assert.equal((await turn(call, "before-update")).result, "echo:before-update");
    const clients = oauth.clients.size;

    // Activate the candidate through the update path (snapshot, switch, validate).
    const services = {
      assistants,
      assistantRuntime: runtime,
      assistantChannels: {
        pause: async () => {},
        resume() {},
        store: { list: () => [] },
      },
      assistantReminders: { webhook: { jobs: new Set() }, hasRunning: async () => false },
    };
    const updates = new RuntimeUpdates({
      dataDir,
      runtime,
      maintenance: new AssistantMaintenance(services),
      stage: async () => candidate,
    });
    await updates.stage();
    await updates.activate();
    assert.equal(updates.status().phase, "complete");
    assert.equal(runtime.status().version, candidate.version);
    assert.equal(selected().version, candidate.version);
    await bind();

    // The candidate's CLI reads the carried-over login.
    const carried = await authStatus();
    assert.equal(carried.state, "authorized");
    assert.equal(carried.hasTokens, true);
    assert.equal(carried.hasClientInformation, true);
    const warningsBefore = sdkWarnings();

    // An expired access token: the candidate refreshes the old login unattended,
    // without a new client registration or authorization.
    oauth.expireAccessTokens();
    const refreshed = grants().length;
    const first = { name: "docs__echo", arguments: { text: "after-update" } };
    assert.equal((await turn(first, "after-update")).result, "echo:after-update");
    assert.deepEqual(grants().slice(refreshed), ["refresh_token"]);
    // A second refresh uses the tokens the first one saved.
    oauth.expireAccessTokens();
    const second = { name: "docs__echo", arguments: { text: "second-refresh" } };
    assert.equal((await turn(second, "second-refresh")).result, "echo:second-refresh");
    assert.deepEqual(grants().slice(refreshed), ["refresh_token", "refresh_token"]);
    assert.equal(oauth.clients.size, clients, "no new client registration");
    assert.equal(
      oauth.log.filter((e) => e.path === "/authorize").length,
      1,
      "no new authorization",
    );
    const after = await authStatus();
    assert.equal(after.state, "authorized");
    assert.ok(after.expiresAt > Date.now() + 3000000);
    // The SDK warns about a login saved without its issuer at most once: the first
    // refresh stamps the tokens it saves, so the second one does not warn again.
    const warned = sdkWarnings() - warningsBefore;
    t.diagnostic(`SDK missing-issuer warnings after the update: ${warned}`);
    assert.ok(warned <= 1, `${warned} missing-issuer warnings`);

    // Survives a restart of the updated Gateway as well.
    await runtime.restart();
    await bind();
    assert.equal((await authStatus()).state, "authorized");
  },
);
