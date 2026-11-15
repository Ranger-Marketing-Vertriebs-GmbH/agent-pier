import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import { approve, oauthMcpServer } from "../helpers/mcp-oauth-test-server.js";
import {
  harness as compiledHarness,
  sleep,
} from "../helpers/mcp-oauth-compiled-harness.js";

// Uses scripts/provision-assistant-contracts.mjs. Unlike the hand-run OpenClaw CLI of
// assistant-mcp-oauth-contract.test.js, this drives AgentPier's own path: the server
// store, start compile, McpChanges' live patches, McpOAuthLogins with its CLI wrapper
// on the Gateway's private state, and the HTTP routes including the OAuth callback.
const installed = process.env.AGENTPIER_MCP_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_MCP_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: contractTimeout(400000),
};

const fixture = { connectionId: "fixture", modelId: "fixture-model" };
const harness = (t, options) =>
  compiledHarness(t, { ...options, installed, contractDir });

test(
  "an OAuth MCP server logs in through AgentPier's callback and its tools reach the agent",
  options,
  async (t) => {
    const docsServer = await oauthMcpServer();
    t.after(() => docsServer.close());
    // Bound to the same agent and never logged in.
    const spareServer = await oauthMcpServer();
    t.after(() => spareServer.close());
    const tool = (input) => {
      const text = JSON.stringify(input.messages);
      return text.includes("CALL docs__echo")
        ? { name: "docs__echo", arguments: { text: "via-oauth" } }
        : null;
    };
    const h = await harness(t, { tool });
    const { servers, runtime, api, listed, authState, loggedOut, turn, running } = h;
    // Token requests without a tolerated verifier mismatch (below) and the SDK's repeat
    // with the used code right after it.
    const mismatched = (e) => e?.refused === "code_verifier mismatch";
    const tolerated = (e, i, log) =>
      mismatched(e) || (e.refused === "unknown or used code" && mismatched(log[i - 1]));
    const grants = () =>
      docsServer.log
        .filter((e, i, l) => e.grant && !tolerated(e, i, l))
        .map((e) => e.grant);
    // Why a login callback failed: the CLI's message and the server's last requests.
    const brief = ({ path, grant, refused }) => ({ path, grant, refused });
    const why = () =>
      JSON.stringify({ cli: h.failures, server: docsServer.log.slice(-4).map(brief) });

    // The browser's part of a login: approve, then follow the redirect to the callback.
    // Known upstream defect of OpenClaw 2026.9.8 (docs/mcp-oauth-qualification.md (b)):
    // right after a turn started the server without credentials, `login --code` can
    // send a PKCE verifier that does not match the challenge it printed. `mismatch`
    // is true only for exactly that: InvalidGrantError from the CLI, a token request the
    // server refused for its code_verifier, and one login start since `startsFrom`.
    async function authorize(authorizationUrl, startsFrom) {
      const logFrom = docsServer.log.length;
      const failFrom = h.failures.length;
      const back = await approve(authorizationUrl);
      const generation = h.runtime.generation;
      const done = await fetch(back, { redirect: "manual" });
      await h.settle(generation);
      const mismatch =
        h.loginStarts.count === startsFrom + 1 &&
        !/oauth=connected/.test(done.headers.get("location")) &&
        h.failures.slice(failFrom).some((f) => /\bInvalidGrantError\b/.test(f)) &&
        docsServer.log
          .slice(logFrom)
          .some((e) => e.path === "/token" && e.refused === "code_verifier mismatch");
      return { back, done, mismatch };
    }
    // Each login: start, approve, callback; the nudge makes the next turn see it. A
    // verifier mismatch is repeated once and logged; any other failure fails.
    async function login(label, { repeated = false } = {}) {
      const startsFrom = h.loginStarts.count;
      const begun = await api("POST", `/mcp-servers/${docs.id}/oauth/login`);
      assert.equal(begun.body.status, "authorize", label);
      const { back, done, mismatch } = await authorize(
        begun.body.authorizationUrl,
        startsFrom,
      );
      assert.equal(done.status, 303, label);
      if (mismatch && !repeated) {
        t.diagnostic(
          `${label}: OpenClaw code_verifier mismatch, login repeated ${why()}`,
        );
        return login(label, { repeated: true });
      }
      assert.match(done.headers.get("location"), /oauth=connected/, `${label} ${why()}`);
      assert.equal((await listed("docs")).oauthStatus, "connected", label);
      return back;
    }
    const agent = h.store.createAssistant({
      name: "Bound",
      instructions: "Use the tool.",
      model: fixture,
    });

    // The owner's path: create both OAuth servers over HTTP and bind them.
    const created = await api("POST", "/mcp-servers", {
      name: "docs",
      transport: "http",
      url: docsServer.url,
      auth: "oauth",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const docs = created.body;
    const spare = (
      await api("POST", "/mcp-servers", {
        name: "spare",
        transport: "http",
        url: spareServer.url,
        auth: "oauth",
      })
    ).body;
    assert.deepEqual(
      h.audit.map((e) => [e.action, e.resourceId]),
      [
        ["mcp.created", docs.id],
        ["mcp.created", spare.id],
      ],
    );
    await h.assistants.update(
      agent.id,
      { mcpServers: [docs.id, spare.id] },
      h.store.getAssistant(agent.id).revision,
    );

    await runtime.start();
    await h.config.apply(agent.id);
    assert.equal(runtime.status().availability, "ready");
    const generation = runtime.generation;

    // The start compiled both with AgentPier's loopback redirect and no headers.
    const redirectUrl = h.redirectUrl();
    assert.deepEqual(runtime.mcp.servers, ["docs", "spare"]);
    assert.equal(runtime.mcp.redirectUrl, redirectUrl);
    const compiled = (await running()).mcp.servers;
    for (const [name, server] of [
      ["docs", docsServer],
      ["spare", spareServer],
    ]) {
      assert.equal(compiled[name].url, server.url);
      assert.equal(compiled[name].auth, "oauth");
      assert.deepEqual(compiled[name].oauth, { redirectUrl });
      assert.equal(compiled[name].headers, undefined);
    }
    assert.equal((await listed("docs")).oauthStatus, "not-connected");
    assert.equal(await authState("docs"), "unauthenticated");

    // Without credentials the turn runs, offers no tools, and backs both servers off.
    assert.deepEqual((await turn(agent, "before-login")).offered, []);
    assert.ok(docsServer.log.some((e) => e.path === "/mcp" && e.rejected === "missing"));
    // The failed start leaves pending-authorization without a registered client: a
    // server never logged in still reads "not connected".
    assert.deepEqual((await h.cliStatus()).docs, {
      state: "pending-authorization",
      hasTokens: false,
      requiresAuthorization: false,
      hasClientInformation: false,
    });
    h.oauth.invalidate();
    assert.equal((await listed("docs")).oauthStatus, "not-connected");

    // Login start through the route: OpenClaw prints the URL for the compiled redirect.
    // The first token is stale at once within OpenClaw's 30 s expiry skew.
    docsServer.state.expiresIn = 31;
    const startsFrom = h.loginStarts.count;
    const started = await api("POST", `/mcp-servers/${docs.id}/oauth/login`);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.status, "authorize");
    const authorizationUrl = new URL(started.body.authorizationUrl);
    assert.equal(authorizationUrl.origin, docsServer.origin);
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), redirectUrl);
    assert.equal((await listed("docs")).oauthStatus, "login-pending");

    // The browser follows the URL; the provider redirects to AgentPier's callback.
    const first = await authorize(authorizationUrl.href, startsFrom);
    let callback = first.back;
    assert.equal(`${callback.origin}${callback.pathname}`, redirectUrl);
    assert.equal(first.done.status, 303);
    if (first.mismatch) {
      t.diagnostic(`first: OpenClaw code_verifier mismatch, login repeated ${why()}`);
      callback = await login("first", { repeated: true });
    } else
      assert.equal(
        first.done.headers.get("location"),
        `/accounts?oauth=connected&server=${docs.id}`,
        why(),
      );
    docsServer.state.expiresIn = 3600;
    // The state is single use.
    const replayed = await fetch(callback, { redirect: "manual" });
    assert.equal(replayed.status, 303);
    assert.equal(
      replayed.headers.get("location"),
      "/accounts?oauth=error&reason=state-invalid",
    );
    const connected = await listed("docs");
    assert.equal(connected.oauthStatus, "connected");
    assert.ok(Number.isFinite(connected.oauthExpiresAt));
    assert.equal(await authState("docs"), "authorized");
    assert.equal((await listed("spare")).oauthStatus, "not-connected");
    // The post-login nudge: a hot `mcp` change that lifts the failed start's backoff.
    // Since 2026.10.10 the login's window restarted the Gateway, which lifts it too.
    const windowed = h.offline.guarded();
    assert.equal((await running()).mcp.sessionIdleTtlMs, windowed ? undefined : 0);

    // The next turn, within the backoff window of the failed one, is offered the tool;
    // OpenClaw refreshed the stale token unattended. The spare server stays out.
    await sleep(1500);
    assert.deepEqual(grants(), ["authorization_code"]);
    assert.deepEqual((await turn(agent, "after-login")).offered, ["docs__echo"]);
    assert.ok(grants().includes("refresh_token"), JSON.stringify(grants()));
    assert.equal((await turn(agent, "CALL docs__echo")).result, "echo:via-oauth");
    assert.equal(docsServer.calls.length, 1);
    assert.match(docsServer.calls[0].bearer, /^at-/);
    // A server-side expiry: OpenClaw refreshes and retries the call unattended.
    docsServer.expireAccessTokens();
    const before = grants().length;
    const logBefore = docsServer.log.length;
    const again = await turn(agent, "CALL docs__echo again");
    // The server log tells a missed refresh from a dropped retry.
    assert.equal(
      again.result,
      "echo:via-oauth",
      JSON.stringify({ ...again, server: docsServer.log.slice(logBefore) }),
    );
    assert.deepEqual(grants().slice(before), ["refresh_token"]);
    assert.equal(spareServer.log.filter((e) => e.path === "/token").length, 0);

    // Logout through the route: tokens gone, tools gone.
    const out = await api("POST", `/mcp-servers/${docs.id}/oauth/logout`);
    assert.equal(out.status, 204);
    await loggedOut("docs");
    assert.equal((await listed("docs")).oauthStatus, "not-connected");
    assert.deepEqual((await turn(agent, "after-logout")).offered, []);

    await login("second");
    assert.deepEqual((await turn(agent, "second-login")).offered, ["docs__echo"]);

    // A rename logs out under the old name before it is saved: renaming back finds no
    // login, where OpenClaw alone keeps the orphaned row (oauth contract (e)).
    const rename = async (name) => {
      const res = await api("PUT", `/mcp-servers/${docs.id}`, {
        name,
        revision: servers.get(docs.id).revision,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body;
    };
    const renamed = await rename("renamed");
    assert.equal(renamed.oauthWarning, undefined);
    assert.deepEqual(runtime.mcp.servers, ["renamed", "spare"]);
    await loggedOut("renamed");
    assert.deepEqual((await turn(agent, "renamed")).offered, []);
    await rename("docs");
    assert.deepEqual(runtime.mcp.servers, ["docs", "spare"]);
    await loggedOut("docs", "old login gone");
    assert.equal((await listed("docs")).oauthStatus, "not-connected");
    // Before 2026.10.10 nothing restarts; since then each sign-in step has a window.
    if (!windowed) assert.equal(runtime.generation, generation, "no restart");

    // A logout that fails is deferred: the rename is saved, the server with the old
    // name and URL stays uncompiled, and the next start drains it before compiling.
    await login("third");
    await runtime.stop();
    h.logouts.fail = true;
    const moved = await rename("moved");
    assert.equal(moved.oauthWarning.code, "oauth-logout-deferred");
    await rename("docs");
    assert.ok(
      servers
        .deferredLogouts()
        .some((d) => d.name === "docs" && d.url === docsServer.url),
    );
    const held = await listed("docs");
    assert.equal(held.oauthStatus, "login-required");
    assert.equal(held.oauthReason.code, "logout-pending");
    // The real logouts resume only when the start drains them.
    h.starts.beforeDrain = () => {
      h.logouts.fail = false;
      h.starts.beforeDrain = null;
    };
    const drainedFrom = h.logouts.calls.length;
    await runtime.start();
    await h.config.apply(agent.id);
    assert.ok(
      h.logouts.calls.slice(drainedFrom).some((c) => c.name === "docs" && !c.failed),
      JSON.stringify(h.logouts.calls),
    );
    assert.deepEqual(servers.deferredLogouts(), []);
    assert.deepEqual(runtime.mcp.servers, ["docs", "spare"]);
    assert.equal(await authState("docs"), "unauthenticated", "drained at the start");
    assert.equal((await listed("docs")).oauthStatus, "not-connected");
    assert.deepEqual((await turn(agent, "after-drain")).offered, []);

    // A login after the drain works as the first did.
    await login("after-drain");
    assert.deepEqual((await turn(agent, "fourth-login")).offered, ["docs__echo"]);
  },
);
