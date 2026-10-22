import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { gatewayPath } from "../../server/features/assistants/runtime-config.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import {
  endStdioServers,
  httpMcpServer,
  leakedFiles,
  stdioMcpScript,
  stdioRecords,
} from "../helpers/mcp-test-servers.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

// The installation provisioned by scripts/provision-assistant-contracts.mjs.
// docs/assistant-mcp-qualification.md records what this contract establishes.
const installed = process.env.AGENTPIER_MCP_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_MCP_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: contractTimeout(300000),
};

// Markers for a header and an environment value: they must reach the servers but
// never a configuration read, a tool result or a log.
const headerValue = "mcp-header-marker-4711";
const envValue = "mcp-env-marker-4712";
// Server names with a dot and a dash; OpenClaw offers them as `docs-v2-http__echo`
// and `local-stdio__echo`.
const httpName = "docs.v2-http";
const stdioName = "local-stdio";
const globs = ["docs-v2-http__*", "local-stdio__*"];

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const starts = (file) => stdioRecords(file).filter((e) => e.event === "start");

/** A Gateway with a bound and an unbound agent on the deterministic model. */
async function harness(t, { team }) {
  assert.ok(path.isAbsolute(installed) && path.isAbsolute(contractDir));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-mcp-"));
  const store = new AssistantStore({ dataDir });
  const ledger = new RequestLedger(store.db);
  const tool = { name: "session_status", arguments: {} };
  const model = await assistantModelServer({ tool });
  const fixture = { connectionId: "fixture", modelId: "fixture-model" };
  const create = (name) =>
    store.createAssistant({ name, instructions: "Use the tool.", model: fixture });
  const bound = create("Bound");
  const unbound = create("Unbound");
  let selected;
  const runtime = new RuntimeSupervisor({
    dataDir,
    install: async () => {
      selected = await selectedAssistantRuntime({ dataDir: contractDir });
      assert.ok(path.resolve(selected.nodePath).startsWith(installed + path.sep));
      if (!team) return selected;
      return {
        ...selected,
        teamPlugin: provisionTeamPlugin({
          paths: runtime.paths,
          runtimeVersion: selected.version,
        }),
      };
    },
  });
  const bridge = new TeamBridge({
    assistants: { store, ledger, runtime },
    generation: () => runtime.generation,
    teams: { store: { context: () => ({ kind: "owner" }) } },
  });
  t.after(async () => {
    try {
      await runtime.close();
      await bridge.close();
      await model.close();
      store.close();
    } finally {
      // Safety net: no stdio server outlives the test, even after a failure.
      for (const name of fs.readdirSync(dataDir))
        if (name.endsWith(".jsonl")) await endStdioServers(path.join(dataDir, name));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  if (team)
    runtime.teamConfiguration = async (descriptor) => ({
      directory: descriptor.teamPlugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "mcp-fixture" },
      profiles: store.listAssistants(),
      webTools: {
        search: { provider: "duckduckgo" },
        browser: { available: false },
        searchPlugins: descriptor.searchPlugins || {},
      },
    });
  await runtime.start();
  const config = new AssistantConfig({
    store,
    workspaces: runtime.paths.workspaces,
    client: runtime.client,
    ...(team && { teamReady: () => bridge.status().ready }),
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
  if (team) config.webToolsAvailable = () => runtime.webTools.availability;
  await config.apply(bound.id);
  await config.apply(unbound.id);

  // One turn on a new session; returns the tools offered and the last tool result.
  async function turn(agent, call, label) {
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
    const offered = (requests[0]?.tools ?? []).map((d) => d.function.name);
    t.diagnostic(`${label} offered=${JSON.stringify(offered)} result=${result}`);
    return { offered, result };
  }
  const servers = (record, extra = {}) => ({
    [httpName]: {
      url: extra.url,
      transport: "streamable-http",
      headers: { "X-Fixture-Marker": headerValue },
    },
    [stdioName]: {
      // The Gateway's PATH is restricted; AgentPier stores absolute commands.
      command: selected.nodePath,
      args: [stdioMcpScript, record],
      env: { MCP_FIXTURE_SECRET: envValue },
      cwd: extra.cwd,
    },
  });
  // Replaces the global and the bound agent's MCP allow entries.
  const allow = (globalEntries, agentEntries) =>
    patchConfig(runtime.client, (current) => {
      const own = (list) => list.filter((n) => n !== "bundle-mcp" && !n.includes("__"));
      const entry = current.agents.entries[bound.runtimeAgentId];
      return {
        patch: {
          tools: { allow: [...own(current.tools.allow), ...globalEntries] },
          agents: {
            entries: {
              [bound.runtimeAgentId]: {
                tools: { allow: [...own(entry.tools.allow), ...agentEntries] },
              },
            },
          },
        },
        replacePaths: [
          "tools.allow",
          `agents.entries.${bound.runtimeAgentId}.tools.allow`,
        ],
      };
    });
  return {
    dataDir,
    runtime,
    node: selected.nodePath,
    bound,
    unbound,
    turn,
    servers,
    allow,
  };
}

const mcpTools = (offered) => offered.filter((n) => n.includes("__")).sort();

test(
  "the Gateway connects HTTP and stdio MCP servers for the bound agent only",
  options,
  async (t) => {
    const http = await httpMcpServer();
    t.after(() => http.close());
    const { dataDir, runtime, node, bound, unbound, turn, servers, allow } =
      await harness(t, { team: false });
    const client = runtime.client;
    const record = path.join(dataDir, "stdio-record.jsonl");
    const cwd = fs.mkdtempSync(path.join(dataDir, "stdio-cwd-"));

    // Every mcp.servers path the contract writes reloads hot.
    for (const key of [
      "mcp",
      "mcp.servers",
      "mcp.servers.*.url",
      "mcp.servers.*.transport",
      "mcp.servers.*.headers",
      "mcp.servers.*.command",
      "mcp.servers.*.args",
      "mcp.servers.*.env",
      "mcp.servers.*.cwd",
      "tools.allow",
    ]) {
      const lookup = await client.call("config.schema.lookup", { path: key });
      assert.equal(lookup.reloadKind, "hot", key);
    }
    const headers = await client.call("config.schema.lookup", {
      path: "mcp.servers.*.headers",
    });
    assert.equal(headers.children[0].hint.sensitive, true);

    const generation = runtime.generation;
    await patchConfig(client, () => ({
      patch: { mcp: { servers: servers(record, { url: http.url, cwd }) } },
    }));
    // Configuration reads redact header and environment values.
    const { config } = await client.call("config.get", {});
    assert.equal(config.mcp.servers[httpName].transport, "streamable-http");
    assert.notEqual(
      config.mcp.servers[httpName].headers["X-Fixture-Marker"],
      headerValue,
    );
    assert.notEqual(config.mcp.servers[stdioName].env.MCP_FIXTURE_SECRET, envValue);
    assert.equal(JSON.stringify(config).includes(headerValue), false);

    // Neither level alone offers the tools: the global list needs `bundle-mcp` (or
    // the server globs) and the agent's own list the sanitised server globs.
    await allow(["bundle-mcp"], []);
    assert.deepEqual(mcpTools((await turn(bound, null, "global-only")).offered), []);
    await allow([], globs);
    assert.deepEqual(mcpTools((await turn(bound, null, "agent-only")).offered), []);
    // The raw name with its dot does not match the sanitised tool names.
    await allow(["bundle-mcp"], ["docs.v2-http__*", "local-stdio__*"]);
    assert.deepEqual(mcpTools((await turn(bound, null, "raw-name")).offered), [
      "local-stdio__echo",
    ]);
    await allow(["bundle-mcp"], globs);
    const offered = mcpTools((await turn(bound, null, "bound")).offered);
    assert.deepEqual(offered, ["docs-v2-http__echo", "local-stdio__echo"]);
    // The unbound agent is offered nothing, yet its new session still starts its own
    // stdio server process: discovery does not follow the allow lists.
    const before = starts(record).length;
    assert.deepEqual(mcpTools((await turn(unbound, null, "unbound")).offered), []);
    assert.equal(starts(record).length, before + 1, "unbound session's stdio process");

    // Calls reach both servers, with the configured header and environment.
    const fromHttp = await turn(
      bound,
      { name: "docs-v2-http__echo", arguments: { text: "over-http" } },
      "call-http",
    );
    assert.equal(fromHttp.result, "echo:over-http");
    assert.equal(http.calls.at(-1).text, "over-http");
    assert.equal(http.calls.at(-1).headers["x-fixture-marker"], headerValue);
    const fromStdio = await turn(
      bound,
      { name: "local-stdio__echo", arguments: { text: "over-stdio" } },
      "call-stdio",
    );
    assert.equal(fromStdio.result, "echo:over-stdio");
    const calls = stdioRecords(record).filter((e) => e.event === "call");
    assert.deepEqual(
      calls.map((c) => c.text),
      ["over-stdio"],
    );
    // The unbound agent's own call cannot run.
    await turn(
      unbound,
      { name: "local-stdio__echo", arguments: { text: "unbound" } },
      "unbound-call",
    );
    assert.equal(stdioRecords(record).filter((e) => e.event === "call").length, 1);
    assert.equal(
      http.calls.filter((c) => c.text !== "over-http").length,
      0,
      "unbound HTTP call",
    );

    // The stdio server runs with the Gateway's environment: private HOME, no
    // TMPDIR, a restricted PATH, the configured cwd and env.
    const started = starts(record);
    const [first] = started;
    t.diagnostic(`stdio starts=${started.length} first=${JSON.stringify(first)}`);
    assert.equal(first.env.HOME, runtime.paths.home);
    assert.equal(first.env.TMPDIR, undefined);
    // The stdio server inherits the Gateway's PATH: the runtime's Node first, and
    // the same owner login PATH exec gets (runtime.shell.pathPrepend) plus /usr/bin
    // and /bin, sanitised by gatewayPath. OpenClaw's PATH bootstrap reorders it
    // (system directories right after Node) and may append its platform's standard
    // directories (macOS: Homebrew and /usr/local/bin; Linux: Linuxbrew). Nothing
    // else reaches it, and no Homebrew directory is assumed to exist.
    const expected = gatewayPath(node, runtime.shell.pathPrepend).split(path.delimiter);
    const dirs = first.env.PATH.split(path.delimiter);
    t.diagnostic(`stdio PATH=${JSON.stringify(dirs)}`);
    assert.equal(dirs[0], path.dirname(node));
    for (const dir of expected) assert.ok(dirs.includes(dir), `missing ${dir}`);
    const standard =
      /^(\/opt\/homebrew|\/usr\/local|\/home\/linuxbrew\/\.linuxbrew)\/s?bin$/;
    for (const dir of dirs)
      assert.ok(expected.includes(dir) || standard.test(dir), `unexpected ${dir}`);
    assert.equal(fs.realpathSync(first.cwd), fs.realpathSync(cwd));
    assert.equal(first.env.MCP_FIXTURE_SECRET, "set");
    // One stdio process per session (eight turns so far), each kept running.
    assert.equal(started.length, 8);
    assert.ok(
      started.every((s) => alive(s.pid)),
      "stdio servers stay up",
    );

    // Removing a server needs replacePaths for its args array; its processes end.
    await patchConfig(client, () => ({
      patch: { mcp: { servers: { [stdioName]: null } } },
      replacePaths: [`mcp.servers.${stdioName}.args`],
    }));
    const { config: after } = await client.call("config.get", {});
    assert.deepEqual(Object.keys(after.mcp.servers), [httpName]);
    for (let n = 0; n < 50 && started.some((s) => alive(s.pid)); n++)
      await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(
      started.filter((s) => alive(s.pid)).map((s) => s.pid),
      [],
      "removed server's processes",
    );
    assert.deepEqual(mcpTools((await turn(bound, null, "removed")).offered), [
      "docs-v2-http__echo",
    ]);
    assert.equal(runtime.generation, generation, "no restart");

    // Neither value appears in a session transcript, log or other state file.
    assert.deepEqual(leakedFiles(dataDir, [headerValue, envValue]), []);
  },
);

test(
  "an HTTP server without a transport uses SSE and offers no tools from a Streamable HTTP server",
  options,
  async (t) => {
    const http = await httpMcpServer();
    t.after(() => http.close());
    const { runtime, bound, turn, allow } = await harness(t, { team: false });
    await patchConfig(runtime.client, () => ({
      patch: { mcp: { servers: { plain: { url: http.url } } } },
    }));
    await allow(["bundle-mcp"], ["plain__*"]);
    assert.deepEqual(mcpTools((await turn(bound, null, "sse-default")).offered), []);
    // Only the SSE GET arrived; no MCP POST was made.
    assert.ok(http.state.requests >= 1);
    assert.ok(
      http.state.methods.every((m) => m.startsWith("GET text/event-stream")),
      JSON.stringify(http.state.methods),
    );
  },
);

test(
  "OpenClaw sanitises, prefixes and truncates MCP server names in tool names",
  options,
  async (t) => {
    const { dataDir, runtime, node, bound, turn, allow } = await harness(t, {
      team: false,
    });
    const stdio = (n) => ({
      command: node,
      args: [stdioMcpScript, path.join(dataDir, `${n}.jsonl`)],
    });
    const long = "x".repeat(40);
    await patchConfig(runtime.client, () => ({
      patch: {
        mcp: {
          servers: {
            "9lives": stdio("digit"),
            "My Server": stdio("space"),
            Upper_Case: stdio("upper"),
            [`${long}-tail`]: stdio("tail"),
            [`${long}-other`]: stdio("other"),
          },
        },
      },
    }));
    await allow(["bundle-mcp"], ["bundle-mcp"]);
    assert.deepEqual(mcpTools((await turn(bound, null, "names")).offered), [
      "My-Server__echo",
      "Upper_Case__echo",
      "mcp-9lives__echo",
      `${"x".repeat(28)}-2__echo`,
      `${"x".repeat(30)}__echo`,
    ]);
  },
);

test(
  "under the team plugin's restrictive plugins.allow MCP servers hot-apply without a restart",
  options,
  async (t) => {
    const http = await httpMcpServer();
    t.after(() => http.close());
    const { dataDir, runtime, bound, unbound, turn, servers, allow } = await harness(t, {
      team: true,
    });
    const client = runtime.client;
    const record = path.join(dataDir, "stdio-record.jsonl");
    const { config: initial } = await client.call("config.get", {});
    assert.deepEqual(initial.plugins.allow, ["agentpier-teams", "openai", "memory-core"]);
    const generation = runtime.generation;
    const log = path.join(runtime.paths.logs, "gateway-console.log");
    const logFrom = fs.statSync(log).size;

    await patchConfig(client, () => ({
      patch: { mcp: { servers: servers(record, { url: http.url }) } },
    }));
    await allow(["bundle-mcp"], globs);
    // `bundle-mcp` is not a plugin id for plugins.allow, and none is needed.
    const { config } = await client.call("config.get", {});
    assert.deepEqual(config.plugins.allow, ["agentpier-teams", "openai", "memory-core"]);
    const listed = await client.call("plugins.list", {});
    assert.equal(
      (listed.plugins ?? listed).some((p) => p.id === "bundle-mcp"),
      false,
    );

    const offered = mcpTools((await turn(bound, null, "team-bound")).offered);
    assert.deepEqual(offered, ["docs-v2-http__echo", "local-stdio__echo"]);
    assert.deepEqual(mcpTools((await turn(unbound, null, "team-unbound")).offered), []);
    const fromHttp = await turn(
      bound,
      { name: "docs-v2-http__echo", arguments: { text: "team-http" } },
      "team-http",
    );
    assert.equal(fromHttp.result, "echo:team-http");
    assert.equal(http.calls.at(-1).headers["x-fixture-marker"], headerValue);
    const fromStdio = await turn(
      bound,
      { name: "local-stdio__echo", arguments: { text: "team-stdio" } },
      "team-stdio",
    );
    assert.equal(fromStdio.result, "echo:team-stdio");

    // No restart: same generation, no restart request in the log, and the next
    // patch is accepted (a pending recovery restart would refuse it).
    assert.equal(runtime.generation, generation);
    assert.equal(runtime.status().availability, "ready");
    const logged = fs.readFileSync(log, "utf8").slice(logFrom);
    assert.doesNotMatch(logged, /requires gateway restart/);
    await patchConfig(client, () => ({ patch: { mcp: { sessionIdleTtlMs: 0 } } }));
    assert.equal(runtime.generation, generation);
    assert.deepEqual(leakedFiles(dataDir, [headerValue, envValue]), []);
  },
);
