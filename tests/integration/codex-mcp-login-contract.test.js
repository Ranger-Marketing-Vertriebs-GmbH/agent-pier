import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { CodexMcpLogins } from "../../server/features/mcp-servers/codex-mcp-logins.js";
import {
  browserAttempts,
  codexArgs,
  installedClis,
  isolatedHome,
  keychainAttempts,
  run,
} from "../helpers/cli-contract.js";
import { approve, oauthMcpServer } from "../helpers/mcp-oauth-test-server.js";

// The brokered Codex login (codex-mcp-logins.js) against the installed Codex, pinned to
// the version docs/cli-mcp-qualification.md qualifies ("OAuth login brokering"). Each
// account is its own temporary HOME (isolatedHome()), logins use the file store, and
// the provider is the local fake authorization server; nothing of the owner is read.
const qualified = "0.160.1";
const enabled = process.env.AGENTPIER_CLI_MCP_CONTRACT === "1";
const codex = enabled ? installedClis().codex : null;
const options = {
  skip: !enabled
    ? "set AGENTPIER_CLI_MCP_CONTRACT=1 to run the installed Codex in a temporary HOME"
    : !codex && "codex is not installed",
  timeout: 300000,
};
const base = "https://agentpier.example.test/api/mcp-servers/cli-oauth/callback";

test("Codex logins are brokered per account and routed by state", options, async (t) => {
  const version = (await run(codex, ["--version"], isolatedHome(t).env)).text;
  assert.match(
    version,
    new RegExp(`\\b${qualified.replaceAll(".", "\\.")}\\b`),
    `Codex ${version.trim()} is not the qualified ${qualified}: re-run this contract and update docs/cli-mcp-qualification.md`,
  );
  const oauth = await oauthMcpServer();
  t.after(() => oauth.close());
  const homes = { a1: isolatedHome(t), a2: isolatedHome(t) };
  for (const home of Object.values(homes))
    fs.writeFileSync(
      path.join(home.codexHome, "config.toml"),
      stringifyToml({ mcp_servers: { probe: { url: oauth.url } } }),
      { mode: 0o600 },
    );
  const settled = [];
  const logins = new CodexMcpLogins({
    accounts: {
      home: homes.a1.home,
      get: (id) => ({ id, name: id, tool: "codex", kind: "managed" }),
      environment: (id) => homes[id].env,
      codexCredentialArgs: () => codexArgs(),
    },
    servers: {
      get: () => ({ id: "s1", name: "probe", transport: "http", auth: "oauth" }),
      bindings: () => ["s1"],
    },
    tools: () => [{ id: "codex", installed: true, path: codex }],
    callbackBase: () => base,
    remoteUrl: () => "https://agentpier.example.test",
    onSettled: (event) => settled.push(event),
    warn: () => {},
  });
  t.after(() => logins.close());
  const origin = { requestOrigin: "https://agentpier.example.test" };
  const status = async (id) =>
    JSON.parse(
      (await run(codex, codexArgs("mcp", "list", "--json"), homes[id].env)).stdout,
    ).find((entry) => entry.name === "probe")?.auth_status;
  const callbackOf = async (authorizationUrl, query) => {
    const callback = await approve(authorizationUrl);
    return `${callback.pathname}${query ? `?${query(callback)}` : callback.search}`;
  };

  // Two accounts log in to the same server at once: one path segment, two states.
  const first = await logins.start("s1", "a1", origin);
  const second = await logins.start("s1", "a2", origin);
  const redirects = [first, second].map((started) =>
    new URL(started.authorizationUrl).searchParams.get("redirect_uri"),
  );
  assert.equal(redirects[0], redirects[1]);
  assert.ok(redirects[0].startsWith(`${base}/`));
  // Approved in reverse order; each callback reaches its own login.
  const two = await callbackOf(second.authorizationUrl);
  const one = await callbackOf(first.authorizationUrl);
  assert.deepEqual(await logins.complete(two), {
    serverId: "s1",
    accountId: "a2",
    result: "connected",
  });
  assert.equal((await logins.complete(one)).result, "connected");
  assert.deepEqual([await status("a1"), await status("a2")], ["o_auth", "o_auth"]);
  for (const home of Object.values(homes))
    assert.ok(fs.existsSync(path.join(home.codexHome, ".credentials.json")));
  assert.deepEqual(await logins.complete(one), {
    result: "error",
    reason: "state-invalid",
  });

  // A refusal at the provider is handed through; Codex stores nothing.
  await run(codex, codexArgs("mcp", "logout", "probe"), homes.a1.env);
  const denied = await logins.start("s1", "a1", origin);
  const deniedState = new URL(denied.authorizationUrl).searchParams.get("state");
  const deniedPath = new URL(
    new URL(denied.authorizationUrl).searchParams.get("redirect_uri"),
  ).pathname;
  assert.deepEqual(
    await logins.complete(`${deniedPath}?error=access_denied&state=${deniedState}`),
    { serverId: "s1", accountId: "a1", result: "error", reason: "access_denied" },
  );
  assert.equal(await status("a1"), "not_logged_in");

  // A cancelled login leaves no lock behind: the next one starts at once.
  await logins.start("s1", "a1", origin);
  assert.equal(logins.cancel("s1", "a1"), true);
  const again = await logins.start("s1", "a1", origin);
  assert.equal(
    (await logins.complete(await callbackOf(again.authorizationUrl))).result,
    "connected",
  );

  assert.equal(settled.length, 4);
  for (const home of Object.values(homes)) {
    assert.deepEqual(keychainAttempts(home), []);
    assert.deepEqual(browserAttempts(home), []);
  }
});
