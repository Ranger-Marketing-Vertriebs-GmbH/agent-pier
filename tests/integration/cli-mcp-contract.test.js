import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { cases, codexAuthStatus, command, url } from "../fixtures/cli-mcp-shapes.js";
import {
  browserAttempts,
  codexArgs,
  installedClis,
  isolatedHome,
  run,
} from "../helpers/cli-contract.js";
import { httpMcpServer } from "../helpers/mcp-test-servers.js";
import { sseMcpServer } from "../helpers/mcp-sse-server.js";
import { oauthMcpServer } from "../helpers/mcp-oauth-test-server.js";

// docs/cli-mcp-qualification.md records what this contract establishes.
const enabled = process.env.AGENTPIER_CLI_MCP_CONTRACT === "1";
const bins = enabled ? installedClis() : {};
const options = (cli) => ({
  skip: !enabled
    ? "set AGENTPIER_CLI_MCP_CONTRACT=1 to run the installed CLIs in a temporary HOME"
    : !bins[cli] && `${cli} is not installed`,
  timeout: 300000,
});

async function liveServers(t) {
  const servers = {
    http: await httpMcpServer(),
    sse: await sseMcpServer(),
    oauth: await oauthMcpServer(),
  };
  t.after(() => Promise.all(Object.values(servers).map((server) => server.close())));
  return { http: servers.http.url, sse: servers.sse.url, oauth: servers.oauth.url };
}

/** The fixture's entries for `cli`, named `ap-<case>` and pointed at live servers. */
function live(cli, servers) {
  const entries = {};
  for (const item of cases) {
    if (!item.native[cli]) continue;
    const target =
      item.central.auth === "oauth"
        ? servers.oauth
        : item.central.transport === "sse"
          ? servers.sse
          : servers.http;
    entries[`ap-${item.id}`] = JSON.parse(
      JSON.stringify(item.native[cli]).replaceAll(url, target),
    );
  }
  return entries;
}
const lineOf = (text, name) =>
  text.split("\n").find((line) => new RegExp(`(^|\\s)${name}(:|\\s)`).test(line));

test(
  "Claude Code lists every written entry with its transport and keeps it unchanged",
  options("claude"),
  async (t) => {
    // CLAUDE_CONFIG_DIR (with its secure storage) lies in the temporary HOME, so
    // Claude Code reads this .claude.json, never the owner's file or credentials.
    const isolated = isolatedHome(t);
    const { env, claudeConfig } = isolated;
    const entries = live("claude", await liveServers(t));
    const file = path.join(claudeConfig, ".claude.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: entries }, null, 2), {
      mode: 0o600,
    });
    const list = await run(bins.claude, ["mcp", "list"], env);
    t.diagnostic(list.text);
    for (const [name, entry] of Object.entries(entries)) {
      const line = lineOf(list.text, name);
      assert.ok(line, `${name} is listed:\n${list.text}`);
      if (entry.type === "http") assert.match(line, /\(HTTP\)/);
      if (entry.type === "sse") assert.match(line, /\(SSE\)/);
    }
    // Live header servers connect: the SSE form works.
    for (const name of ["ap-http", "ap-sse"])
      assert.match(lineOf(list.text, name), /Connected/);
    // An OAuth entry without a login asks for authentication instead of failing.
    for (const name of ["ap-http-oauth", "ap-sse-oauth"])
      assert.match(lineOf(list.text, name), /auth/i);
    // Claude rewrites ~/.claude.json on every start; AgentPier's entries survive as written.
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers, entries);
    // A stdio working directory is not part of Claude's schema: it is dropped.
    await run(
      bins.claude,
      [
        "mcp",
        "add-json",
        "-s",
        "user",
        "with-cwd",
        JSON.stringify({ type: "stdio", command, args: [], cwd: "/tmp" }),
      ],
      env,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["with-cwd"].cwd,
      undefined,
    );
    assert.deepEqual(browserAttempts(isolated), []);
  },
);

test(
  "Codex lists every written entry, keeps cwd, and has no SSE form",
  options("codex"),
  async (t) => {
    const isolated = isolatedHome(t);
    const { home, env } = isolated;
    const servers = await liveServers(t);
    const entries = live("codex", servers);
    // Codex's only remote form is streamable HTTP, even for an SSE endpoint.
    entries["ap-sse-as-http"] = { url: servers.sse, http_headers: {} };
    const file = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, stringifyToml({ mcp_servers: entries }), { mode: 0o600 });
    const listing = await run(bins.codex, codexArgs("mcp", "list", "--json"), env);
    t.diagnostic(listing.stdout);
    const listed = JSON.parse(listing.stdout);
    const byName = Object.fromEntries(listed.map((entry) => [entry.name, entry]));
    for (const name of Object.keys(entries)) assert.ok(byName[name], name);
    assert.equal(byName["ap-stdio"].transport.type, "stdio");
    assert.equal(byName["ap-stdio-cwd"].transport.cwd, "/tmp");
    assert.equal(byName["ap-http"].transport.type, "streamable_http");
    assert.deepEqual(Object.keys(byName["ap-http"].transport.http_headers), [
      "Authorization",
    ]);
    assert.equal(byName["ap-sse-as-http"].transport.type, "streamable_http");
    assert.equal(byName["ap-http-oauth"].auth_status, codexAuthStatus.loggedOut);
    // smol-toml parses tables into null-prototype objects; compare plain values.
    const written = parseToml(fs.readFileSync(file, "utf8")).mcp_servers;
    assert.deepEqual(JSON.parse(JSON.stringify(written)), entries);
    assert.deepEqual(browserAttempts(isolated), []);
  },
);

test(
  "OpenCode lists every written entry, keeps cwd, and reaches SSE through remote",
  options("opencode"),
  async (t) => {
    const isolated = isolatedHome(t);
    const { home, env } = isolated;
    const entries = live("opencode", await liveServers(t));
    const marker = path.join(home, "cwd-marker");
    // A dedicated directory, compared by real path (on macOS /tmp is /private/tmp).
    const cwd = path.join(home, "cwd-target");
    fs.mkdirSync(cwd, { mode: 0o700 });
    // Not an MCP server: it only records the directory OpenCode starts it in.
    const probe = {
      type: "local",
      command: [
        process.execPath,
        "-e",
        "require('fs').writeFileSync(process.argv[1], process.cwd())",
        marker,
      ],
      cwd,
      enabled: true,
    };
    const file = path.join(home, ".config/opencode/opencode.jsonc");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      file,
      JSON.stringify({ mcp: { ...entries, "ap-cwd-probe": probe } }, null, 2),
      { mode: 0o600 },
    );
    const list = await run(bins.opencode, ["mcp", "list"], env);
    t.diagnostic(list.text);
    for (const name of Object.keys(entries))
      assert.ok(lineOf(list.text, name), `${name}:\n${list.text}`);
    for (const name of ["ap-http", "ap-sse"])
      assert.match(lineOf(list.text, name), /connected/);
    // The marker proves OpenCode started the command, in the configured `cwd`.
    assert.ok(
      fs.existsSync(marker),
      `OpenCode did not start the cwd probe:\n${list.text}`,
    );
    const started = fs.realpathSync(fs.readFileSync(marker, "utf8"));
    t.diagnostic(`cwd probe started in ${started}`);
    assert.equal(started, fs.realpathSync(cwd));
    const auth = await run(bins.opencode, ["mcp", "auth", "list"], env);
    t.diagnostic(auth.text);
    assert.match(auth.text, /ap-http-oauth[\s\S]*?not authenticated/);
    const after = JSON.parse(fs.readFileSync(file, "utf8")).mcp;
    delete after["ap-cwd-probe"];
    assert.deepEqual(after, entries);
    assert.deepEqual(browserAttempts(isolated), []);
  },
);
