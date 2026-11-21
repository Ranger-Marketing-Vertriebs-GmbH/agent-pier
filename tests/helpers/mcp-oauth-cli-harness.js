import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "./process-guard.js";
import { contractTimeout } from "./contract-timeout.js";
import {
  assistantModelServer,
  offeredToolNames,
  discoveredToolNames,
} from "./assistant-model-server.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtimes/openclaw/runtime-install.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtimes/openclaw/runtime-config.js";
import { patchConfig } from "../../server/features/assistants/runtimes/openclaw/live-patch.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";
import { offlineOnly } from "../../server/features/assistants/runtimes/openclaw/offline-commands.js";
import {
  defaultBusyRetryDelaysMs,
  leaseLocked,
  parseLoginOutput,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-mcp-cli.js";

// The hand-run OpenClaw CLI of assistant-mcp-oauth-contract.test.js.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mcpTools = (offered) => offered.filter((n) => n.includes("__")).sort();

/** Holds a loopback port, as AgentPier's own listener holds the redirect port. */
export async function holdPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * A Gateway with one agent on the deterministic model, and the OpenClaw CLI.
 * `installed`: the provisioned runtime root; `contractDir`: the contract data.
 */
export async function harness(t, { installed, contractDir }) {
  assert.ok(path.isAbsolute(installed) && path.isAbsolute(contractDir));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-mcp-oauth-"));
  const store = new AssistantStore({ dataDir });
  const tool = { name: "none", arguments: {} };
  const model = await assistantModelServer({ tool, discover: "echo" });
  const fixture = { connectionId: "fixture", modelId: "fixture-model" };
  const agent = store.createAssistant({
    name: "Bound",
    instructions: "Use the tool.",
    model: fixture,
  });
  let selected;
  const runtime = new RuntimeSupervisor({
    dataDir,
    install: async () => {
      selected = await selectedAssistantRuntime({ dataDir: contractDir });
      assert.ok(path.resolve(selected.nodePath).startsWith(installed + path.sep));
      return selected;
    },
  });
  // Each step runs even when an earlier one throws.
  t.after(async () => {
    try {
      await runtime.close();
    } finally {
      try {
        await model.close();
      } finally {
        try {
          store.close();
        } finally {
          fs.rmSync(dataDir, { recursive: true, force: true });
        }
      }
    }
  });
  await runtime.start();
  const config = new AssistantConfig({
    store,
    workspaces: runtime.paths.workspaces,
    runtime,
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
  await config.apply(agent.id);
  // One turn on a new session; returns the tools offered and the last tool result.
  async function turn(call, label) {
    const began = Date.now();
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
    const result = requests
      .flatMap((r) => r.messages || [])
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content))
      .at(-1);
    const offered = mcpTools([
      ...offeredToolNames(requests[0]),
      ...discoveredToolNames(requests),
    ]);
    t.diagnostic(
      `${label} offered=${JSON.stringify(offered)} result=${result} ms=${Date.now() - began}`,
    );
    return { offered, result };
  }

  // The Gateway's own environment; the CLI then reads and writes its private state.
  const token = JSON.parse(fs.readFileSync(runtime.paths.config, "utf8")).gateway.auth
    .token;
  // With OPENCLAW_DEBUG like createMcpCli: 2026.10 prints "Reason:" only then.
  const gatewayEnv = runtimeEnvironment(runtime.paths, selected.nodePath, token);
  gatewayEnv.OPENCLAW_DEBUG = "1";
  // Like createMcpCli: a call whose lease transaction could not start while the
  // Gateway wrote the shared state database did nothing and is repeated.
  // OpenClaw 2026.10.10 and later sign in and out only while no Gateway owns the
  // state (offline-commands.js): such a call beside the running Gateway runs in a
  // window of its own, as AgentPier runs it.
  const windowed = offlineOnly(selected.version);
  const guarded = (args) => args[0] === "mcp" && ["login", "logout"].includes(args[1]);
  async function cli(args, env = gatewayEnv) {
    if (windowed && guarded(args) && runtime.child) return offline(() => cli(args, env));
    for (let attempt = 0; ; attempt++) {
      const run = await cliOnce(args, env);
      if (run.code === 0 || !leaseLocked(run.stderr)) return run;
      if (attempt >= defaultBusyRetryDelaysMs.length) return run;
      await sleep(defaultBusyRetryDelaysMs[attempt]);
    }
  }
  function cliOnce(args, env) {
    const started = Date.now();
    return new Promise((resolve) => {
      execFile(
        selected.nodePath,
        [selected.entryPath, ...args],
        { env, cwd: runtime.paths.root, timeout: contractTimeout(90000) },
        (error, stdout, stderr) => {
          const run = {
            code: error ? (error.code ?? null) : 0,
            signal: error?.signal ?? null,
            stdout,
            stderr,
            ms: Date.now() - started,
          };
          t.diagnostic(`cli ${args.join(" ")} -> ${JSON.stringify(run)}`);
          resolve(run);
        },
      );
    });
  }
  async function status(name, env) {
    const run = await cli(["mcp", "status", "--json"], env);
    assert.equal(run.code, 0, run.stderr);
    const parsed = JSON.parse(run.stdout);
    return { parsed, server: parsed.servers.find((s) => s.name === name) };
  }
  const allow = (entries) =>
    patchConfig(runtime.client, (current) => {
      const own = (list) => list.filter((n) => n !== "bundle-mcp" && !n.includes("__"));
      const entry = current.agents.entries[agent.runtimeAgentId];
      return {
        patch: {
          tools: { allow: [...own(current.tools.allow), "bundle-mcp"] },
          agents: {
            entries: {
              [agent.runtimeAgentId]: {
                tools: { allow: [...own(entry.tools.allow), ...entries] },
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
  const servers = (patch, replace = []) =>
    patchConfig(runtime.client, () => ({
      patch: { mcp: { servers: patch } },
      replacePaths: replace,
    }));
  /**
   * `openclaw mcp login <name>` with its redirect port taken: `{ run, url }`. OpenClaw's
   * console redaction masks about one PKCE challenge in 200; like createMcpCli's
   * startLogin, such a login is repeated (twice at most) instead of handing out a
   * URL whose challenge no longer matches the verifier.
   */
  async function login(name, env) {
    for (let attempt = 1; ; attempt++) {
      const run = await cli(["mcp", "login", name], env);
      assert.equal(run.code, 0, run.stderr);
      const parsed = parseLoginOutput(run.stdout, name);
      if (parsed?.redacted && attempt < 3) {
        t.diagnostic(`login ${name}: redacted authorization URL, attempt ${attempt}`);
        continue;
      }
      assert.ok(parsed?.authorizationUrl, run.stdout);
      return { run, url: new URL(parsed.authorizationUrl) };
    }
  }
  /**
   * Stops the Gateway, runs `work` and starts it again. Its start compiles neither
   * the servers nor the agent's tools (live patches here), so they are patched back.
   */
  async function offline(work) {
    const began = Date.now();
    const before = (await runtime.client.call("config.get", {})).config;
    const id = agent.runtimeAgentId;
    const own = before.agents.entries[id].tools.allow;
    await runtime.stop();
    windows.count++;
    const stopped = Date.now();
    let worked;
    try {
      return await work();
    } finally {
      worked = Date.now();
      await runtime.start();
      config.reset();
      await config.apply(agent.id);
      await patchConfig(runtime.client, () => ({
        patch: {
          mcp: before.mcp,
          tools: { allow: before.tools.allow },
          agents: { entries: { [id]: { tools: { allow: own } } } },
        },
        replacePaths: ["mcp", "tools.allow", `agents.entries.${id}.tools.allow`],
      }));
      // Where a slow runner's time goes: stopping, the work, starting again.
      t.diagnostic(
        `window ${windows.count}: stop ${stopped - began} ms, work ${worked - stopped} ms, restart ${Date.now() - worked} ms`,
      );
    }
  }
  const windows = { count: 0, windowed };
  return {
    dataDir,
    runtime,
    turn,
    cli,
    login,
    status,
    allow,
    servers,
    gatewayEnv,
    offline,
    windows,
    // The CLI as is, never in a window.
    direct: (args, env = gatewayEnv) => cliOnce(args, env),
  };
}
