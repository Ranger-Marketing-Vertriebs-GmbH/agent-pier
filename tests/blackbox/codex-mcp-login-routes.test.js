import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "../helpers/application.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-codex-mcp.mjs", import.meta.url));

/** The fake Codex (tests/fixtures/fake-codex-mcp.mjs) first on PATH; returns its call log. */
function fakeCodex(t) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-fake-codex-"));
  const log = path.join(bin, "calls.log");
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!/bin/sh\nFAKE_CODEX_LOG='${log}' exec '${process.execPath}' '${fixture}' "$@"\n`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => {
    process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
  });
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return { calls, bin };
}

function captureLogs(t) {
  const lines = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(" "));
    t.after(() => (console[level] = original));
  }
  return lines;
}

async function setup(t) {
  const { calls, bin } = fakeCodex(t);
  const logs = captureLogs(t);
  // Runs the detected Codex: the fake one first on PATH.
  const f = await applicationFixture(t, { realCliOAuthStatus: true });
  t.after(() => f.dispose());
  // Never the real Codex: refuse to go on unless detection picked the fake.
  const detected = f.application.tools().find((tool) => tool.id === "codex");
  assert.equal(path.dirname(detected?.path ?? ""), bin, "the fake Codex is detected");
  const call = async (endpoint, options) => {
    const response = await f.request(endpoint, options);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  };
  const account = (
    await call("/api/accounts", { method: "POST", body: { name: "Work", tool: "codex" } })
  ).body;
  const server = (
    await call("/api/mcp-servers", {
      method: "POST",
      body: {
        name: "docs",
        transport: "http",
        url: "https://login.example.test/mcp",
        auth: "oauth",
        clis: ["codex"],
      },
    })
  ).body;
  const login = (accountId = account.id, method = "POST") =>
    call(`/api/mcp-servers/${server.id}/cli-oauth/codex/login`, {
      method,
      body: { accountId },
    });
  const accounts = async () => {
    await call("/api/mcp-servers");
    await f.application.cliMcp.oauthStatus.settled();
    const list = (await call("/api/mcp-servers")).body;
    return list.find((item) => item.id === server.id).cliStatus.codex.oauth.accounts;
  };
  return { f, call, calls, logs, account, server, login, accounts };
}

/**
 * The provider's redirect back: a cross-site navigation without AgentPier's cookie
 * (node:http, since fetch replaces the Sec-Fetch headers). Resolves `{ status, location }`.
 */
const navigate = (f, target, { method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      new URL(target, f.url),
      {
        method,
        headers: {
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          "sec-fetch-site": "cross-site",
          ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }),
          ...headers,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode, location: response.headers.location }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });

test("a managed Codex account logs in through AgentPier's callback", async (t) => {
  const { f, call, calls, logs, account, server, login, accounts } = await setup(t);
  assert.deepEqual(await accounts(), [
    { id: account.id, name: "Work", state: "unknown" },
  ]);
  const started = await login();
  assert.equal(started.status, 200);
  const authorize = new URL(started.body.authorizationUrl);
  const state = authorize.searchParams.get("state");
  const redirect = new URL(authorize.searchParams.get("redirect_uri"));
  assert.equal(redirect.origin, f.url, "the loopback origin without a remote URL");
  assert.equal(redirect.pathname, "/api/mcp-servers/cli-oauth/callback/SEGMENT12345");
  // Run in the account's own CODEX_HOME with the file stores pinned.
  const run = calls().find((entry) => entry.args.includes("login"));
  assert.equal(run.codexHome, path.join(f.dataDir, "profiles", account.id, "codex"));
  assert.ok(run.args.includes('mcp_oauth_credentials_store="file"'));
  assert.equal(
    (await accounts()).find((item) => item.id === account.id).state,
    "pending",
  );

  const back = await navigate(f, `${redirect.pathname}?code=c-secret-1&state=${state}`);
  assert.equal(back.status, 303);
  const target = new URL(back.location, f.url);
  assert.equal(target.pathname, "/accounts");
  assert.deepEqual(Object.fromEntries(target.searchParams), {
    oauth: "connected",
    server: server.id,
    cli: "codex",
    account: account.id,
  });
  assert.deepEqual(await accounts(), [
    { id: account.id, name: "Work", state: "connected" },
  ]);
  // Used once: the same callback again is refused.
  const again = await navigate(f, `${redirect.pathname}?code=c-secret-1&state=${state}`);
  assert.match(again.location, /oauth=error&reason=state-invalid/);

  const audit = (await call("/api/audit?limit=50")).text;
  assert.match(audit, /"mcp\.started"/);
  assert.match(audit, /"mcp\.completed"/);
  for (const text of [audit, logs.join("\n")]) {
    assert.doesNotMatch(text, /c-secret-1/);
    assert.doesNotMatch(text, new RegExp(state));
  }
});

test("a refused login, a cancel and the owner's own profile", async (t) => {
  const { f, account, server, login, accounts } = await setup(t);
  const started = await login();
  const authorize = new URL(started.body.authorizationUrl);
  const path_ = new URL(authorize.searchParams.get("redirect_uri")).pathname;
  const state = authorize.searchParams.get("state");
  const back = await navigate(f, `${path_}?error=access_denied&state=${state}`);
  const target = new URL(back.location, f.url);
  assert.deepEqual(Object.fromEntries(target.searchParams), {
    oauth: "error",
    server: server.id,
    cli: "codex",
    account: account.id,
    reason: "access_denied",
  });
  assert.deepEqual(await accounts(), [
    { id: account.id, name: "Work", state: "failed", reason: "access_denied" },
  ]);

  await login();
  const cancelled = await login(account.id, "DELETE");
  assert.equal(cancelled.status, 204);
  assert.equal((await accounts())[0].state, "login-required");

  const own = await login("local-codex");
  assert.deepEqual([own.status, own.body.code], [409, "account-invalid"]);
  const unknown = await navigate(f, `${path_}?code=x&state=forged`);
  assert.match(unknown.location, /oauth=error&reason=state-invalid/);
  const head = await fetch(new URL(`${path_}?state=x`, f.url), { method: "HEAD" });
  assert.equal(head.status, 405);
  // Without a cookie the owner routes stay closed.
  const anonymous = await fetch(
    new URL(`/api/mcp-servers/${server.id}/cli-oauth/codex/login`, f.url),
    {
      method: "POST",
      headers: { origin: f.url, "content-type": "application/json" },
      body: JSON.stringify({ accountId: account.id }),
    },
  );
  assert.equal(anonymous.status, 401);
});

test("cross-site requests and deeper callback paths are refused", async (t) => {
  const { f, account, server } = await setup(t);
  // A page on another site cannot start or cancel a login with the owner's cookie.
  for (const method of ["POST", "DELETE"]) {
    const refused = await navigate(
      f,
      `/api/mcp-servers/${server.id}/cli-oauth/codex/login`,
      {
        method,
        headers: {
          cookie: f.cookie,
          origin: "https://evil.example.test",
          "content-type": "application/json",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
        },
        body: JSON.stringify({ accountId: account.id }),
      },
    );
    assert.equal(refused.status, 403, method);
  }
  assert.equal(f.application.codexMcpLogins.byKey.size, 0, "nothing started");
  // Only one path segment after the callback is a top-level navigation target.
  const deeper = await navigate(f, "/api/mcp-servers/cli-oauth/callback/a/b?state=x");
  assert.equal(deeper.status, 403);
});

test("removing the account or unbinding the server ends a pending login", async (t) => {
  const { f, call, account, server, login, accounts } = await setup(t);
  await login();
  assert.equal((await accounts())[0].state, "pending");
  const unbound = await call(`/api/mcp-servers/${server.id}/clis`, {
    method: "PUT",
    body: { clis: [] },
  });
  assert.equal(unbound.status, 200);
  assert.equal(f.application.codexMcpLogins.byKey.size, 0);
  await call(`/api/mcp-servers/${server.id}/clis`, {
    method: "PUT",
    body: { clis: ["codex"] },
  });
  await login();
  assert.equal(
    (await call(`/api/accounts/${account.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(f.application.codexMcpLogins.byKey.size, 0);
  const audit = (await call("/api/audit?limit=50")).text;
  assert.match(audit, /"failReason":"obsolete"/);
});
