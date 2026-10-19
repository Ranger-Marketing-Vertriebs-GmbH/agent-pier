import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtime-config.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import {
  authorize,
  exchanged,
  oauthMcpServer,
} from "../helpers/mcp-oauth-test-server.js";
import { nudgedIdleTtl } from "../../server/features/mcp-servers/mcp-oauth-logins.js";
import {
  createMcpCli,
  defaultBusyRetryDelaysMs,
  leaseLocked,
  parseLoginOutput,
} from "../../server/features/mcp-servers/openclaw-mcp-cli.js";

// Uses scripts/provision-assistant-contracts.mjs; see docs/mcp-oauth-qualification.md.
const installed = process.env.AGENTPIER_MCP_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_MCP_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: contractTimeout(300000),
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
  // With OPENCLAW_DEBUG like createMcpCli: 2026.10 prints "Reason:" only then.
  const gatewayEnv = runtimeEnvironment(runtime.paths, selected.nodePath, token);
  gatewayEnv.OPENCLAW_DEBUG = "1";
  // Like createMcpCli: a call whose lease transaction could not start while the
  // Gateway wrote the shared state database did nothing and is repeated.
  async function cli(args, env = gatewayEnv) {
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
  return { dataDir, runtime, turn, cli, login, status, allow, servers, gatewayEnv };
}

test(
  "OpenClaw MCP OAuth: login prints the URL, --code completes, tokens refresh",
  options,
  async (t) => {
    const oauth = await oauthMcpServer();
    t.after(() => oauth.close());
    const held = await holdPort();
    t.after(() => held.close());
    const { runtime, turn, cli, login, status, allow, servers, gatewayEnv } =
      await harness(t);
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
    assert.deepEqual(Object.keys(first.parsed).sort(), ["path", "servers"]);
    assert.equal(first.parsed.path, gatewayEnv.OPENCLAW_CONFIG_PATH);
    assert.deepEqual(Object.keys(first.server).sort(), [
      "auth",
      "authStatus",
      "configured",
      "connectionTimeoutMs",
      "enabled",
      "launch",
      "name",
      "ok",
      "requestTimeoutMs",
      "supportsParallelToolCalls",
      "transport",
    ]);
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
    const { run: started, url: authorizationUrl } = await login("docs");
    assert.equal(started.stderr, "");
    assert.ok(started.ms < 30000, `${started.ms} ms`);
    // The URL line itself is checked by its parameters (authorize, below).
    const printed = started.stdout.split("\n");
    assert.deepEqual(printed.toSpliced(2, 1), [
      `Could not start the local OAuth callback (listen EADDRINUSE: address already in use 127.0.0.1:${held.port}).`,
      'Open this URL to authorize "docs":',
      "After approval, run openclaw mcp login docs --code <code>.",
      "",
    ]);
    assert.equal(new URL(printed[2]).href, authorizationUrl.href);
    const query = authorizationUrl.searchParams;
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
    const callback = await authorize(oauth, authorizationUrl, redirectUrl);
    assert.equal(callback.searchParams.get("state"), query.get("state"));
    const code = callback.searchParams.get("code");
    const exchangedFrom = Date.now();
    const done = await cli(["mcp", "login", "docs", "--code", code]);
    const exchangedTo = Date.now();
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.stdout, 'MCP OAuth credentials saved for "docs".\n');
    exchanged(oauth);
    oauth.state.expiresIn = 3600;
    const authorized = await state("docs");
    // Issued during the --code run, however slow the runner.
    const { expiresAt } = authorized;
    assert.ok(expiresAt >= exchangedFrom + 30000, `${expiresAt - exchangedFrom} ms`);
    assert.ok(expiresAt <= exchangedTo + 32000, `${expiresAt - exchangedTo} ms`);
    assert.deepEqual(authorized, {
      hasTokens: true,
      requiresAuthorization: false,
      hasClientInformation: true,
      hasCodeVerifier: false,
      hasDiscoveryState: true,
      hasLastAuthorizationUrl: false,
      expiresAt,
      state: "authorized",
    });
    // Once completed, the session is gone: a second --code fails at once.
    const reused = await cli(["mcp", "login", "docs", "--code", code]);
    assert.equal(reused.code, 1);
    assert.match(reused.stderr, /Missing MCP OAuth authorization session/);
    // Without it only "The CLI command failed." and a doctor hint: nothing to classify.
    const { OPENCLAW_DEBUG: _debug, ...quiet } = gatewayEnv;
    const hidden = await cli(["mcp", "login", "docs", "--code", code], quiet);
    assert.equal(hidden.code, 1);
    assert.doesNotMatch(hidden.stderr, /Reason:/);

    // (b, d) The next turn refreshes the stale token unattended and offers the tool.
    // Stale once now + 30 s passes expiresAt: wait until then, with a margin.
    await sleep(Math.max(0, expiresAt - 30000 - Date.now()) + 2000);
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
    const failedStart = Date.now();
    // The SDK drops the tokens on invalid_grant: `pending-authorization`, no tokens.
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
    const relogin = await login("docs");
    const recallback = await authorize(oauth, relogin.url, redirectUrl);
    const redone = await cli([
      "mcp",
      "login",
      "docs",
      "--code",
      recallback.searchParams.get("code"),
    ]);
    assert.equal(redone.code, 0, redone.stderr);
    exchanged(oauth);
    assert.equal((await state("docs")).state, "authorized");
    // The failed start above backs the server off for 30 s (doubling up to 10 min);
    // a new session within that window is offered nothing despite valid tokens. Only
    // a slow runner (AGENTPIER_CONTRACT_TIME_SCALE) may need longer for the login.
    const inWindow = Date.now() - failedStart < 20000 || !(contractTimeout(1) > 1);
    const relogged = (await turn(null, "relogin-backed-off")).offered;
    assert.deepEqual(relogged, inWindow ? [] : relogged, "the backoff holds the server");
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

    // (e) Logout clears the store: no tokens, client, verifier or discovery remain.
    const logout = await cli(["mcp", "logout", "docs"]);
    assert.equal(logout.code, 0, logout.stderr);
    assert.equal(logout.stdout, 'MCP OAuth credentials cleared for "docs".\n');
    const noFlags = { ...first.server.authStatus };
    delete noFlags.state;
    const { state: cleared, ...clearedFlags } = await state("docs");
    assert.deepEqual(clearedFlags, noFlags);
    // `unauthenticated`, unless a Gateway MCP request reached the server after the
    // logout (macOS CI saw one): its 401 records the challenge on the cleared store.
    // With the Gateway stopped nothing writes the store; (f) asserts the exact status.
    assert.ok(["unauthenticated", "pending-authorization"].includes(cleared), cleared);
    // A turn after the logout settles it: the start without a token records the
    // challenge, `pending-authorization` without any flag (as a server never logged in).
    await patchConfig(client, (config) => ({
      patch: { mcp: { sessionIdleTtlMs: nudgedIdleTtl(config.mcp?.sessionIdleTtlMs) } },
    }));
    assert.deepEqual((await turn(null, "logged-out")).offered, []);
    assert.deepEqual(await state("docs"), {
      ...noFlags,
      state: "pending-authorization",
    });

    // (e) Log in again, then rename and change the URL: both orphan the login.
    const third = await login("docs");
    const thirdCallback = await authorize(oauth, third.url, redirectUrl);
    const thirdDone = await cli([
      "mcp",
      "login",
      "docs",
      "--code",
      thirdCallback.searchParams.get("code"),
    ]);
    assert.equal(thirdDone.code, 0, thirdDone.stderr);
    exchanged(oauth);
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
    const fourth = await login("docs");
    const fourthCallback = await authorize(oauth, fourth.url, redirectUrl);
    const fourthDone = await cli([
      "mcp",
      "login",
      "docs",
      "--code",
      fourthCallback.searchParams.get("code"),
    ]);
    assert.equal(fourthDone.code, 0, fourthDone.stderr);
    exchanged(oauth);

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
    assert.deepEqual(await state("docs", minimal), first.server.authStatus);
  },
);

test(
  "OpenClaw MCP OAuth: an HTTPS redirect URL still prints the authorization URL",
  options,
  async (t) => {
    const oauth = await oauthMcpServer();
    t.after(() => oauth.close());
    const { cli, login, status, servers } = await harness(t);
    const redirectUrl = "https://agentpier.invalid/api/mcp-servers/oauth/callback";
    await servers({
      secure: {
        url: oauth.url,
        transport: "streamable-http",
        auth: "oauth",
        oauth: { redirectUrl },
      },
    });
    const { run, url } = await login("secure");
    const printed = run.stdout.split("\n");
    assert.deepEqual(printed.toSpliced(2, 1), [
      "Could not start the local OAuth callback (OAuth callback redirect must use HTTP on a loopback address).",
      'Open this URL to authorize "secure":',
      "After approval, run openclaw mcp login secure --code <code>.",
      "",
    ]);
    assert.equal(new URL(printed[2]).href, url.href);
    const callback = await authorize(oauth, url, redirectUrl);
    assert.equal(callback.origin, "https://agentpier.invalid");
    const done = await cli([
      "mcp",
      "login",
      "secure",
      "--code",
      callback.searchParams.get("code"),
    ]);
    assert.equal(done.code, 0, done.stderr);
    exchanged(oauth);
    assert.equal((await status("secure")).server.authStatus.state, "authorized");
  },
);
