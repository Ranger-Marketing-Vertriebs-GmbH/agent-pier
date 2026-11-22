import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { patchConfig } from "../../server/features/assistants/runtimes/openclaw/live-patch.js";
import {
  authorize,
  exchanged,
  oauthMcpServer,
} from "../helpers/mcp-oauth-test-server.js";
import {
  harness as cliHarness,
  holdPort,
  sleep,
} from "../helpers/mcp-oauth-cli-harness.js";
import { nudgedIdleTtl } from "../../server/features/mcp-servers/mcp-oauth-logins.js";
import { createMcpCli } from "../../server/features/assistants/runtimes/openclaw/openclaw-mcp-cli.js";

// Uses scripts/provision-assistant-contracts.mjs; see docs/mcp-oauth-qualification.md.
const installed = process.env.AGENTPIER_MCP_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_MCP_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  // The CLI steps run in maintenance windows since 2026.10.10, each a Gateway restart
  // (5 s locally, up to about 25 s on a macOS runner) plus CLI runs of 1 to 6 s. The
  // sign-in flow was split in two tests (four and three windows) once the single
  // test of seven reached 456 s of its 480 s on macOS (2.20.0-rc.5).
  timeout: contractTimeout(480000),
};
const harness = (t) => cliHarness(t, { installed, contractDir });

// One sign-in in a window of its own: login, the browser's approval, --code.
const signIn = (h, oauth, redirectUrl, name = "docs") =>
  h.offline(async () => {
    const started = await h.login(name);
    const callback = await authorize(oauth, started.url, redirectUrl);
    return h.cli(["mcp", "login", name, "--code", callback.searchParams.get("code")]);
  });

// The OAuth server with the agent's loopback redirect port held, as AgentPier's
// listener holds it, and the `docs` server that redirects there.
async function oauthSetup(t) {
  const oauth = await oauthMcpServer();
  t.after(() => oauth.close());
  const held = await holdPort();
  t.after(() => held.close());
  const redirectUrl = `http://127.0.0.1:${held.port}/api/mcp-servers/oauth/callback`;
  const docs = {
    url: oauth.url,
    transport: "streamable-http",
    auth: "oauth",
    oauth: { redirectUrl },
  };
  return { oauth, held, redirectUrl, docs };
}

test(
  "OpenClaw MCP OAuth: login prints the URL, --code completes, tokens refresh",
  options,
  async (t) => {
    const { oauth, held, redirectUrl, docs } = await oauthSetup(t);
    const h = await harness(t);
    const { runtime, turn, cli, login, status, allow, servers, gatewayEnv } = h;
    const client = runtime.client;
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

    // A login beside the running Gateway is refused; the harness then runs it in a
    // maintenance window, as AgentPier does (offline-commands.js).
    const refused = await h.direct(["mcp", "login", "docs"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /exclusive offline state ownership/);

    // (a) Login with the redirect port held prints the URL and exits at once.
    // Not stderr: like createMcpCli; OpenClaw may log its WAL upkeep there.
    const { run: started, url: authorizationUrl } = await login("docs");
    assert.ok(started.ms < 30000, `${started.ms} ms`);
    // The URL line itself is checked by its parameters (authorize, below).
    const printed = started.stdout.split("\n");
    assert.deepEqual(printed.toSpliced(2, 1), [
      `Could not start the local OAuth callback (listen EADDRINUSE: address already in use 127.0.0.1:${held.port}).`,
      'Open this URL to authorize "docs":',
      "After approval, run openclaw mcp login docs --code <code>.",
      "If the callback URL includes iss, pass its exact value with --issuer <iss> when completing login manually.",
      "",
    ]);
    assert.equal(new URL(printed[2]).href, authorizationUrl.href);
    const query = authorizationUrl.searchParams;
    // Dynamic client registration as a public native client (2026.11.6) for exactly
    // that redirect URL.
    const [registration] = oauth.log.filter((e) => e.path === "/register");
    assert.deepEqual(registration.metadata, {
      application_type: "native",
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
    // One window for the exchange and the two repeats below.
    const [exchangedFrom, done, exchangedTo, reused, hidden] = await h.offline(
      async () => {
        const from = Date.now();
        const first = await cli(["mcp", "login", "docs", "--code", code]);
        const to = Date.now();
        const { OPENCLAW_DEBUG: _debug, ...quiet } = gatewayEnv;
        return [
          from,
          first,
          to,
          await cli(["mcp", "login", "docs", "--code", code]),
          await cli(["mcp", "login", "docs", "--code", code], quiet),
        ];
      },
    );
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
    assert.equal(reused.code, 1);
    assert.match(reused.stderr, /Missing MCP OAuth authorization session/);
    // Without it only "The CLI command failed." and a doctor hint: nothing to classify.
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
    // 2026.11.6 keeps the stored tokens after invalid_grant and still reports
    // `authorized` (2026.11.3 dropped them and reported `pending-authorization`); the
    // server stays without tools, and the Gateway logs the refusal as an outage it
    // retries ("MCP OAuth refresh failed (400): invalid_grant; server unavailable").
    const revoked = await state("docs");
    t.diagnostic(`after a revoked refresh token: ${JSON.stringify(revoked)}`);
    assert.equal(revoked.hasClientInformation, true);
    assert.equal(revoked.hasCodeVerifier, false);
    assert.match(
      gatewayLog().at(-1),
      /requires OAuth authorization\. Run openclaw mcp login docs|MCP OAuth refresh failed \(400\): invalid_grant/,
    );

    // A new login right after a failed start: the login's maintenance window
    // restarts the Gateway, which lifts the server's backoff.
    oauth.state.refreshRevoked = false;
    const redone = await signIn(h, oauth, redirectUrl);
    assert.equal(redone.code, 0, redone.stderr);
    exchanged(oauth);
    assert.equal((await state("docs")).state, "authorized");
    await turn(null, "relogin-backed-off");
    // AgentPier's reset after a login (McpOAuthLogins.resetBackoff): unset -> 0.
    await patchConfig(runtime.client, (config) => ({
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
    await patchConfig(runtime.client, (config) => ({
      patch: { mcp: { sessionIdleTtlMs: nudgedIdleTtl(config.mcp?.sessionIdleTtlMs) } },
    }));
    assert.deepEqual((await turn(null, "logged-out")).offered, []);
    assert.deepEqual(await state("docs"), {
      ...noFlags,
      state: "pending-authorization",
    });
    // One maintenance window per sign-in step.
    t.diagnostic(`maintenance windows: ${h.windows.count}`);
  },
);

test(
  "OpenClaw MCP OAuth: a rename or a new URL orphans a login; the CLI needs only its state",
  options,
  async (t) => {
    const { oauth, redirectUrl, docs } = await oauthSetup(t);
    const h = await harness(t);
    const { runtime, cli, status, servers, gatewayEnv } = h;
    const grants = () => oauth.log.filter((e) => e.grant).map((e) => e.grant);
    const state = async (name, env) => (await status(name, env)).server.authStatus;
    await servers({ docs });
    const never = await state("docs");
    assert.equal(never.state, "unauthenticated");

    // (e) Log in, then rename and change the URL: both orphan the login.
    const signedIn = await signIn(h, oauth, redirectUrl);
    assert.equal(signedIn.code, 0, signedIn.stderr);
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
    await h.offline(() => own.logout("docs", { server: docs }));
    await servers({ renamed: null, docs }, ["mcp.servers.renamed"]);
    assert.equal((await state("docs")).state, "unauthenticated", "orphan cleared");
    const again = await signIn(h, oauth, redirectUrl);
    assert.equal(again.code, 0, again.stderr);
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
    t.diagnostic(`maintenance windows: ${h.windows.count}`);
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
    assert.deepEqual(await state("docs", minimal), never);
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
      "If the callback URL includes iss, pass its exact value with --issuer <iss> when completing login manually.",
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
