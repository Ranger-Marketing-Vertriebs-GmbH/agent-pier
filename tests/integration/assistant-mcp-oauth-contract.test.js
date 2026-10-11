import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtime-config.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import { approve, oauthMcpServer } from "../helpers/mcp-oauth-test-server.js";
import { nudgedIdleTtl } from "../../server/features/mcp-servers/mcp-oauth-logins.js";
import { createMcpCli } from "../../server/features/mcp-servers/openclaw-mcp-cli.js";

// The installation provisioned by scripts/provision-assistant-contracts.mjs.
// docs/mcp-oauth-qualification.md records what this contract establishes.
const installed = process.env.AGENTPIER_MCP_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_MCP_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: 300000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mcpTools = (offered) => offered.filter((n) => n.includes("__")).sort();

/** Holds a loopback port, as AgentPier's own listener holds the redirect port. */
async function holdPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** A Gateway with one agent on the deterministic model, and the OpenClaw CLI. */
async function harness(t) {
  assert.ok(path.isAbsolute(installed) && path.isAbsolute(contractDir));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-mcp-oauth-"));
  const store = new AssistantStore({ dataDir });
  const tool = { name: "none", arguments: {} };
  const model = await assistantModelServer({ tool });
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
  t.after(async () => {
    try {
      await runtime.close();
      await model.close();
      store.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await runtime.start();
  const config = new AssistantConfig({
    store,
    workspaces: runtime.paths.workspaces,
    client: runtime.client,
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
    Object.assign(tool, call ?? { name: "none", arguments: {} });
    const from = model.requests.length;
    const session = await runtime.client.call("sessions.create", {
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
    const offered = mcpTools((requests[0]?.tools ?? []).map((d) => d.function.name));
    t.diagnostic(`${label} offered=${JSON.stringify(offered)} result=${result}`);
    return { offered, result };
  }

  // The Gateway's own environment; the CLI then reads and writes its private state.
  const token = JSON.parse(fs.readFileSync(runtime.paths.config, "utf8")).gateway.auth
    .token;
  const gatewayEnv = runtimeEnvironment(runtime.paths, selected.nodePath, token);
  function cli(args, env = gatewayEnv) {
    const started = Date.now();
    return new Promise((resolve) => {
      execFile(
        selected.nodePath,
        [selected.entryPath, ...args],
        { env, cwd: runtime.paths.root, timeout: 90000 },
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
  return { dataDir, runtime, turn, cli, status, allow, servers, gatewayEnv };
}

/** `openclaw mcp login <name>` with its redirect port taken; returns the URL line. */
function printedUrl(run, name) {
  const lines = run.stdout.split("\n");
  const at = lines.indexOf(`Open this URL to authorize "${name}":`);
  assert.ok(at >= 0, run.stdout);
  return new URL(lines[at + 1]);
}

test(
  "OpenClaw MCP OAuth: login prints the URL, --code completes, tokens refresh",
  options,
  async (t) => {
    const oauth = await oauthMcpServer();
    t.after(() => oauth.close());
    const held = await holdPort();
    t.after(() => held.close());
    const { runtime, turn, cli, status, allow, servers, gatewayEnv } = await harness(t);
    const client = runtime.client;
    const generation = runtime.generation;
    const redirectUrl = `http://127.0.0.1:${held.port}/api/mcp-servers/oauth/callback`;
    const docs = {
      url: oauth.url,
      transport: "streamable-http",
      auth: "oauth",
      oauth: { redirectUrl },
    };
    const grants = () => oauth.log.filter((e) => e.grant).map((e) => e.grant);
    const state = async (name, env) => (await status(name, env)).server.authStatus;
    const gatewayLog = () =>
      fs
        .readFileSync(path.join(runtime.paths.logs, "gateway-console.log"), "utf8")
        .split("\n")
        .filter((l) => l.includes("bundle-mcp"));

    for (const key of ["mcp.servers.*.auth", "mcp.servers.*.oauth"]) {
      const lookup = await client.call("config.schema.lookup", { path: key });
      assert.equal(lookup.reloadKind, "hot", key);
    }
    await servers({ docs });
    await allow(["docs__*"]);

    // (c) Before any login. No turn runs yet: a failed start backs the server off.
    const first = await status("docs");
    t.diagnostic(`status unauthenticated ${JSON.stringify(first.parsed)}`);
    assert.equal(first.server.auth, "oauth");
    assert.deepEqual(first.server.authStatus, {
      hasTokens: false,
      requiresAuthorization: false,
      hasClientInformation: false,
      hasCodeVerifier: false,
      hasDiscoveryState: false,
      hasLastAuthorizationUrl: false,
      state: "unauthenticated",
    });

    // (a) Login with the redirect port held prints the URL and exits at once.
    const login = await cli(["mcp", "login", "docs"]);
    assert.equal(login.code, 0);
    assert.equal(login.stderr, "");
    assert.ok(login.ms < 30000, `${login.ms} ms`);
    const authorizationUrl = printedUrl(login, "docs");
    assert.deepEqual(login.stdout.split("\n"), [
      `Could not start the local OAuth callback (listen EADDRINUSE: address already in use 127.0.0.1:${held.port}).`,
      'Open this URL to authorize "docs":',
      authorizationUrl.href,
      "After approval, run openclaw mcp login docs --code <code>.",
      "",
    ]);
    assert.equal(
      `${authorizationUrl.origin}${authorizationUrl.pathname}`,
      `${oauth.origin}/authorize`,
    );
    const query = authorizationUrl.searchParams;
    assert.equal(query.get("redirect_uri"), redirectUrl);
    assert.equal(query.get("code_challenge_method"), "S256");
    assert.equal(query.get("resource"), oauth.url);
    assert.match(query.get("state"), /^[0-9a-f-]{36}$/);
    // Dynamic client registration as a public client for exactly that redirect URL.
    const [registration] = oauth.log.filter((e) => e.path === "/register");
    assert.deepEqual(registration.metadata, {
      client_name: "OpenClaw MCP",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    assert.deepEqual(await state("docs"), {
      hasTokens: false,
      requiresAuthorization: false,
      hasClientInformation: true,
      hasCodeVerifier: true,
      hasDiscoveryState: true,
      hasLastAuthorizationUrl: true,
      state: "pending-authorization",
    });

    // (b) The browser returns to the redirect URL; --code completes the login. The
    // CLI takes only the code: checking the callback's state is the caller's job.
    oauth.state.expiresIn = 31; // Stale at once within OpenClaw's 30 s skew.
    const callback = await approve(authorizationUrl.href);
    assert.equal(callback.searchParams.get("state"), query.get("state"));
    const code = callback.searchParams.get("code");
    const done = await cli(["mcp", "login", "docs", "--code", code]);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.stdout, 'MCP OAuth credentials saved for "docs".\n');
    oauth.state.expiresIn = 3600;
    const authorized = await state("docs");
    assert.equal(authorized.state, "authorized");
    assert.equal(authorized.hasTokens, true);
    assert.equal(authorized.hasCodeVerifier, false);
    assert.ok(Math.abs(authorized.expiresAt - (Date.now() + 31000)) < 15000);
    // Once completed, the session is gone: a second --code fails before reaching the
    // authorization server.
    const reused = await cli(["mcp", "login", "docs", "--code", code]);
    assert.equal(reused.code, 1);
    assert.match(reused.stderr, /Missing MCP OAuth authorization session/);

    // (b, d) The next turn, without a config reload, refreshes the stale token
    // unattended and offers the tool.
    await sleep(1500);
    assert.deepEqual(grants(), ["authorization_code"]);
    assert.deepEqual((await turn(null, "after-login")).offered, ["docs__echo"]);
    assert.ok(grants().includes("refresh_token"), JSON.stringify(grants()));
    const call = await turn(
      { name: "docs__echo", arguments: { text: "with-oauth" } },
      "call-oauth",
    );
    assert.equal(call.result, "echo:with-oauth");
    assert.ok((await state("docs")).expiresAt > Date.now() + 3000000);
    // A server-side expiry: the 401 makes OpenClaw refresh and retry once.
    oauth.expireAccessTokens();
    const refreshes = grants().length;
    const again = await turn(
      { name: "docs__echo", arguments: { text: "after-401" } },
      "call-after-401",
    );
    assert.equal(again.result, "echo:after-401");
    assert.deepEqual(grants().slice(refreshes), ["refresh_token"]);

    // (d) A revoked refresh token needs a new login; turns still run without tools.
    oauth.revokeRefreshTokens();
    oauth.expireAccessTokens();
    assert.deepEqual((await turn(null, "revoked")).offered, []);
    // The SDK drops the tokens on invalid_grant, so the state is not
    // `requires-authorization` but `pending-authorization` without tokens.
    assert.deepEqual(await state("docs"), {
      hasTokens: false,
      requiresAuthorization: false,
      hasClientInformation: true,
      hasCodeVerifier: false,
      hasDiscoveryState: true,
      hasLastAuthorizationUrl: false,
      state: "pending-authorization",
    });
    assert.match(
      gatewayLog().at(-1),
      /requires OAuth authorization\. Run openclaw mcp login docs/,
    );

    // A new login right after a failed start: the server stays backed off for the
    // next turn until an `mcp` config change resets the backoff.
    oauth.state.refreshRevoked = false;
    const relogin = await cli(["mcp", "login", "docs"]);
    const recallback = await approve(printedUrl(relogin, "docs").href);
    const redone = await cli([
      "mcp",
      "login",
      "docs",
      "--code",
      recallback.searchParams.get("code"),
    ]);
    assert.equal(redone.code, 0, redone.stderr);
    assert.equal((await state("docs")).state, "authorized");
    // The failed start above backs the server off for 30 s (doubling up to 10 min);
    // a new session within that window is offered nothing despite valid tokens.
    assert.deepEqual((await turn(null, "relogin-backed-off")).offered, []);
    // AgentPier's reset after a login (McpOAuthLogins.resetBackoff): unset -> 0.
    await patchConfig(client, (config) => ({
      patch: { mcp: { sessionIdleTtlMs: nudgedIdleTtl(config.mcp?.sessionIdleTtlMs) } },
    }));
    assert.deepEqual((await turn(null, "relogin-reset")).offered, ["docs__echo"]);

    // (c) A token the server still refuses after one refresh: `requires-authorization`.
    oauth.state.rejectTokens = true;
    const rejectedFrom = grants().length;
    assert.deepEqual((await turn(null, "rejected")).offered, []);
    assert.deepEqual(grants().slice(rejectedFrom), ["refresh_token"]);
    const rejected = await state("docs");
    assert.deepEqual(rejected, {
      hasTokens: true,
      requiresAuthorization: true,
      hasClientInformation: true,
      hasCodeVerifier: false,
      hasDiscoveryState: true,
      hasLastAuthorizationUrl: false,
      state: "requires-authorization",
    });
    oauth.state.rejectTokens = false;

    // (e) Logout clears the store.
    const logout = await cli(["mcp", "logout", "docs"]);
    assert.equal(logout.code, 0, logout.stderr);
    assert.equal(logout.stdout, 'MCP OAuth credentials cleared for "docs".\n');
    assert.deepEqual(await state("docs"), first.server.authStatus);

    // (e) Log in again, then rename and change the URL: both orphan the login.
    const third = await cli(["mcp", "login", "docs"]);
    const thirdCallback = await approve(printedUrl(third, "docs").href);
    const thirdDone = await cli([
      "mcp",
      "login",
      "docs",
      "--code",
      thirdCallback.searchParams.get("code"),
    ]);
    assert.equal(thirdDone.code, 0, thirdDone.stderr);
    assert.equal((await state("docs")).state, "authorized");
    await servers({ docs: null, renamed: docs }, ["mcp.servers.docs"]);
    assert.equal((await state("renamed")).state, "unauthenticated");
    const moved = { ...docs, url: oauth.url.replace("127.0.0.1", "localhost") };
    await servers({ renamed: null, docs: moved }, ["mcp.servers.renamed"]);
    assert.equal((await state("docs")).state, "unauthenticated");
    await servers({ docs }, []);
    assert.equal((await state("docs")).state, "authorized", "orphaned row kept");
    // AgentPier clears such an orphan with a one-server config of its own while the
    // Gateway's config no longer names it (McpOAuthLogins deferred logouts).
    await servers({ docs: null, renamed: docs }, ["mcp.servers.docs"]);
    const own = createMcpCli({
      runtime: { ...runtime.runtime, cwd: runtime.paths.root },
      environment: gatewayEnv,
    });
    await own.logout("docs", { server: docs });
    await servers({ renamed: null, docs }, ["mcp.servers.renamed"]);
    assert.equal((await state("docs")).state, "unauthenticated", "orphan cleared");
    const fourth = await cli(["mcp", "login", "docs"]);
    const fourthCallback = await approve(printedUrl(fourth, "docs").href);
    const fourthDone = await cli([
      "mcp",
      "login",
      "docs",
      "--code",
      fourthCallback.searchParams.get("code"),
    ]);
    assert.equal(fourthDone.code, 0, fourthDone.stderr);

    // (f) The CLI needs only HOME, OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH
    // (and a PATH); no Gateway token and no running Gateway.
    const minimal = {
      PATH: gatewayEnv.PATH,
      HOME: gatewayEnv.HOME,
      OPENCLAW_STATE_DIR: gatewayEnv.OPENCLAW_STATE_DIR,
      OPENCLAW_CONFIG_PATH: gatewayEnv.OPENCLAW_CONFIG_PATH,
    };
    assert.equal((await state("docs", minimal)).state, "authorized");
    const homeOnly = await cli(["mcp", "status", "--json"], {
      PATH: gatewayEnv.PATH,
      HOME: gatewayEnv.HOME,
    });
    // HOME alone points the CLI at <HOME>/.openclaw, not the Gateway's state.
    assert.equal(homeOnly.code, 0);
    assert.deepEqual(JSON.parse(homeOnly.stdout), {
      path: path.join(gatewayEnv.HOME, ".openclaw", "openclaw.json"),
      servers: [],
    });
    assert.equal(runtime.generation, generation, "no restart");
    await runtime.close();
    assert.equal((await state("docs", minimal)).state, "authorized");
    // `login` on a server with a refresh token refreshes and prints no URL.
    const refreshFrom = grants().length;
    const stoppedLogin = await cli(["mcp", "login", "docs"], minimal);
    assert.equal(stoppedLogin.code, 0, stoppedLogin.stderr);
    assert.equal(stoppedLogin.stdout, 'MCP OAuth credentials saved for "docs".\n');
    assert.deepEqual(grants().slice(refreshFrom), ["refresh_token"]);
    const stoppedLogout = await cli(["mcp", "logout", "docs"], minimal);
    assert.equal(stoppedLogout.code, 0, stoppedLogout.stderr);
    assert.equal((await state("docs", minimal)).state, "unauthenticated");
  },
);

test(
  "OpenClaw MCP OAuth: an HTTPS redirect URL still prints the authorization URL",
  options,
  async (t) => {
    const oauth = await oauthMcpServer();
    t.after(() => oauth.close());
    const { cli, status, servers } = await harness(t);
    const redirectUrl = "https://agentpier.invalid/api/mcp-servers/oauth/callback";
    await servers({
      secure: {
        url: oauth.url,
        transport: "streamable-http",
        auth: "oauth",
        oauth: { redirectUrl },
      },
    });
    const login = await cli(["mcp", "login", "secure"]);
    assert.equal(login.code, 0);
    const url = printedUrl(login, "secure");
    assert.deepEqual(login.stdout.split("\n"), [
      "Could not start the local OAuth callback (OAuth callback redirect must use HTTP on a loopback address).",
      'Open this URL to authorize "secure":',
      url.href,
      "After approval, run openclaw mcp login secure --code <code>.",
      "",
    ]);
    assert.equal(url.searchParams.get("redirect_uri"), redirectUrl);
    const callback = await approve(url.href);
    assert.equal(callback.origin, "https://agentpier.invalid");
    const done = await cli([
      "mcp",
      "login",
      "secure",
      "--code",
      callback.searchParams.get("code"),
    ]);
    assert.equal(done.code, 0, done.stderr);
    assert.equal((await status("secure")).server.authStatus.state, "authorized");
  },
);
