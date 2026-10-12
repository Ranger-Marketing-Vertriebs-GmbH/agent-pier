# Central MCP Servers for Coding CLIs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner bind each central MCP server to Claude Code, Codex and OpenCode; AgentPier writes an AgentPier-owned entry into each CLI's shared native configuration, detects hand edits and taken names, offers adoption of entries found in the CLIs, grants bound stdio servers in nono sessions, and replaces the MCP part of the CLI extensions page with a link to the one central list.

**Architecture:** The central store (`McpServerStore`) becomes a core service that exists with or without agents, and gains a `cli` binding kind plus a `cli_entries` table that records, by name and hash only, which native entry AgentPier wrote. A focused reconciler compares the store's bindings with each CLI's canonical native profile (`local-<cli>`, read and written only through `server/features/extensions/mcp-config.js`) and decides per server: written, pending, conflict, name taken or could not write; everything else in the file is a "find". A `CliMcpBindings` service runs the reconciler after every save and before every session start (before the shared-profile projection, so managed accounts receive the entries in the same launch), adopts finds, resolves conflicts, and declares nono grants.

**Tech Stack:** Node.js ≥ 22.13 ES modules, Express 5, SQLite through `server/lib/private-database.js`, `smol-toml`/`jsonc-parser` through `mcp-config.js`, React 19, `node:test` + fast-check, Playwright, `node-pty` (login probe only).

**Spec:** `docs/superpowers/specs/2026-10-12-mcp-cli-bindings-design.md` (binding authority; Plane AGENTPIER-38).

## Global Constraints

- Precondition: PR #229 (`fix/mcp-audit`, AGENTPIER-41 audit of MCP server changes) is merged into `main` and this branch is rebased onto it before Task 2. Task 2 rewrites `server/http/routes/mcp-servers.js`, which #229 also changes; the code below keeps #229's `auditMcp` helper and its `stdioChanged`/`transport` results. If #229 is not merged when Task 2 starts, stop and ask.
- Platforms: macOS and Linux; Node.js 22.13+; no new runtime tools.
- CLIs and versions the contract pins: `claude` 2.1.296, `codex` 0.160.1, `opencode` 1.18.35.
- Binding target kind `cli` with target ids exactly `claude`, `codex`, `opencode`; `targetKinds = ["agent", "cli"]`. Agent bindings are unchanged.
- Central names keep OpenClaw's rule `^[A-Za-z][A-Za-z0-9_-]{0,29}$`.
- Unsupported CLI/transport combinations are refused with `400 MCP_CLI_TRANSPORT_UNSUPPORTED` (spec); a stdio server with a working directory bound to a CLI without one is refused with `400 MCP_CLI_CWD_UNSUPPORTED` (ruling, see Task 3).
- Ownership lives only in AgentPier's data (`cli_entries` in `<data>/mcp-servers/servers.sqlite`); no marker is added to native files. The hash is SHA-256 over the canonical JSON of the native entry as written.
- Native files are written only through `mcp-config.js` (`readConfig`, `updateConfig`, `atomicText` compare-and-swap, mode 0600, `safePath`).
- Unmanaged entries are never modified or removed; adoption is never automatic.
- Header and environment values never appear in logs, audit details or API responses: names only (AGENTPIER-41's rule).
- Order of change: store first, then file; the reconciler compares both and finishes an interrupted change.
- A compare-and-swap failure is re-read and retried, at most 3 attempts per reconciliation.
- AgentPier's own `agentpier_*` servers are per launch and never touched.
- Running sessions see a change only after a restart; the UI says so.
- Every UI text change keeps `web/lib/i18n/de/*.js` and `web/lib/i18n/en/*.js` in parity (same keys, same function arities and interpolations) with reactive exports in `web/lib/i18n/messages/*.js`; server messages live in `server/lib/i18n/{de,en}/mcp-servers.js`.
- Source and test files stay at or below 600 lines (`npm run check:structure`); Prettier and ESLint pass.
- Tests: `node:test` with strict assertions, fast-check for properties, Playwright for browser behaviour. Every test uses a temporary HOME and data directory; nothing reads or writes the owner's `~`, `~/.claude.json`, `~/.claude`, `~/.codex`, `~/.config/opencode`, keychain or default tmux server.
- Commits: English, imperative, prefixes `feat:`/`fix:`/`test:`/`docs:`/`chore:`, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work stays in `.worktrees/mcp-cli-bindings`; never push to `main`.

## Review Focus

1. **A CLI rewriting its own configuration** (Claude Code rewrites `~/.claude.json` on every start; a Codex file reformatted by hand or by `codex mcp`) must leave AgentPier's entries managed, not turn them into conflicts. Pinned by the contract re-read in Task 1 and by "a re-serialized file keeps entries managed" in Task 5.
2. **Renaming a server that is bound to CLIs** must remove the old managed entry and write the new one, leaving nothing behind as a find. Pinned in Task 5.
3. **Editing a header or environment value** of a bound server must rewrite the managed entry (AgentPier's older version), never report it as a hand edit. Pinned in Task 5.
4. **Session start with a malformed CLI configuration** (or any reconciliation failure) must still start the session, with a code-only warning and the nono grants declared. Pinned in Task 7.
5. **"Adopt all" with one entry whose stdio command is a bare name not on AgentPier's PATH** must adopt the others, report the failing one by name, and leave its native entry untouched. Pinned in Task 6.

---

## File Structure

Created:

- `tests/fixtures/cli-mcp-shapes.js` — native entry shapes per CLI × transport × auth, pinned by the contract and produced by `nativeMcp()`.
- `tests/helpers/cli-contract.js` — locates installed CLIs, builds an isolated HOME, runs a CLI.
- `tests/helpers/mcp-sse-server.js` — legacy HTTP+SSE MCP test server.
- `tests/integration/cli-mcp-contract.test.js` — contract against the installed CLIs (env-gated).
- `tests/integration/cli-mcp-login-probe.test.js` — OAuth login brokering probe (env-gated).
- `docs/cli-mcp-qualification.md` — what the contract and the probe established.
- `server/features/mcp-servers/stdio-confirmation.js` — stdio confirmation shared by agents and CLIs.
- `server/features/mcp-servers/central-changes.js` — `CentralMcpChanges`: the central list with or without agents.
- `server/features/mcp-servers/cli-native.js` — CLI ids, support matrix, projection input, canonical hash, native → central parsing, name proposals.
- `server/features/mcp-servers/cli-entry-store.js` — `CliEntryStore` over `cli_entries`.
- `server/features/mcp-servers/cli-reconciler.js` — `CliMcpReconciler`: statuses, writes, removals, conflicts, finds, crash repair.
- `server/features/mcp-servers/cli-finds.js` — grouping and public view of finds.
- `server/features/mcp-servers/cli-adoption.js` — adopting finds and adopting a hand edit.
- `server/features/mcp-servers/cli-grants.js` — nono grants for bound stdio servers.
- `server/features/mcp-servers/cli-bindings.js` — `CliMcpBindings` service.
- `server/features/mcp-servers/cli-oauth-status.js` — Codex OAuth status and login commands.
- `server/http/routes/mcp-cli.js` — CLI binding, conflict and find routes.
- `web/features/mcp-servers/cli-api.js`, `cli-support.js`, `McpCliChoices.jsx`, `McpCliStatus.jsx`, `McpCliFinds.jsx`, `mcp-cli.css`.
- `web/lib/i18n/de/mcp-cli.js`, `web/lib/i18n/en/mcp-cli.js`, `web/lib/i18n/messages/mcp-cli.js`.
- Tests: `tests/unit/mcp-central-changes.test.js`, `tests/blackbox/mcp-servers-without-agents.test.js`, `tests/unit/cli-mcp-native.test.js`, `tests/property/cli-mcp-native.test.js`, `tests/unit/mcp-server-store-cli.test.js`, `tests/helpers/cli-mcp.js`, `tests/integration/cli-mcp-reconciler.test.js`, `tests/integration/cli-mcp-reconciler-recovery.test.js`, `tests/integration/cli-mcp-adoption.test.js`, `tests/unit/cli-mcp-grants.test.js`, `tests/integration/cli-mcp-bindings.test.js`, `tests/unit/cli-oauth-status.test.js`, `tests/blackbox/mcp-cli-routes.test.js`, `tests/unit/mcp-cli-support.test.js`, `tests/browser/mcp-cli-bindings.spec.js`.

Modified:

- `server/features/extensions/mcp-config.js` — `nativeMcp()` gains SSE, OAuth forms and Codex `cwd`; `atomicText` marks a lost compare-and-swap with `CLI_CONFIG_CHANGED`; `cleanMcp` is removed in Task 10.
- `server/features/mcp-servers/mcp-server-store.js` — `cli` kind, `cliEntries`, `targetsOf`, `setClis`, `create(input, { bind })`.
- `server/features/assistants/mcp-changes.js` — imports the shared stdio confirmation.
- `server/application/services.js`, `assistant-graph.js`, `assistants.js`, `shutdown.js`, `session-lifecycle.js`, `session-reload-lifecycle.js` — core store, facade, CLI service, launch hook.
- `server/app.js`, `server/http/routes/mcp-servers.js`, `server/http/routes/assistants.js`, `server/http/routes/extensions.js`, `server/http/responses.js`.
- `server/features/audit/audit-schema.js` — `clis`, `resolution`, `adopted` details.
- `server/features/extensions/extension-store.js` — `addMcp`/`removeMcp` removed (Task 10).
- `server/lib/i18n/{de,en}/mcp-servers.js` — CLI messages.
- `web/features/accounts/AccountsPage.jsx`, `web/app/App.jsx`, `web/app/routes.js`, `web/features/mcp-servers/McpServersSettings.jsx`, `McpServerForm.jsx`, `StdioConfirmation.jsx`, `web/features/extensions/{ExtensionsPage,ExtensionWorkspace,McpTab}.jsx`, `web/lib/i18n/{de,en}/mcp-servers.js`.
- Tests: `tests/integration/extensions.test.js`, `tests/browser/extensions.spec.js`, `tests/unit/audit-schema.test.js`.
- Docs: `docs/mcp.md`, `docs/shared-cli-extensions.md`, `docs/sandbox.md`.

Deleted: `web/features/extensions/McpForm.jsx` (Task 10); this plan and the spec (Task 11).

---

### Task 1: CLI contract and OAuth login probe

Pins, against the installed CLIs in an isolated HOME, the native entry each CLI accepts for every transport × auth, how each one lists them, what it does with an unsupported form, and how OAuth status can be read; and records whether each CLI can complete a login that AgentPier brokers through its own origin. Tasks 3, 7 and 8 take their shapes and status values from `tests/fixtures/cli-mcp-shapes.js`. **Gate:** if a contract assertion fails because a CLI behaves differently from what is written here, change the fixture and `docs/cli-mcp-qualification.md` to the observed behaviour, note the difference in the task that consumes it (Task 3: `nativeMcp`/`cliSupport`; Task 8: `codexAuthStates`), and only then continue.

**Files:**

- Create: `tests/fixtures/cli-mcp-shapes.js`
- Create: `tests/helpers/cli-contract.js`
- Create: `tests/helpers/mcp-sse-server.js`
- Create: `tests/integration/cli-mcp-contract.test.js`
- Create: `tests/integration/cli-mcp-login-probe.test.js`
- Create: `docs/cli-mcp-qualification.md`

**Interfaces:**

- Consumes: `detectTools(env, common, dirs)` (`server/features/accounts/account-store.js:132`), `toolBinDirectories(dataDir)` (`server/features/tools/tool-paths.js:4`), `httpMcpServer()`/`echoServer()` (`tests/helpers/mcp-test-servers.js`), `oauthMcpServer()`/`approve(url)` (`tests/helpers/mcp-oauth-test-server.js`).
- Produces:
  - `cases`: `Array<{ id, central: { transport, url?, command?, args, cwd, auth, oauthScope }, secrets: { headers, env }, native: { claude?, codex?, opencode? }, unsupported?: { [cli]: "transport" | "cwd" } }>`, plus `url` and `command` constants (`tests/fixtures/cli-mcp-shapes.js`).
  - `codexAuthStatus = { loggedIn: "o_auth", loggedOut: "not_logged_in" }` — the `auth_status` values `codex mcp list --json` reports for an OAuth server.
  - `installedClis()`, `isolatedHome(t)`, `run(bin, args, env, options)`, `codexArgs(...args)` (`tests/helpers/cli-contract.js`).
  - `sseMcpServer()` → `{ url, state, close }` (`tests/helpers/mcp-sse-server.js`).

- [ ] **Step 1: Install dependencies in the worktree**

Run: `npm ci`
Expected: completes; `node_modules/@modelcontextprotocol/sdk/dist/esm/server/sse.js` exists.

- [ ] **Step 2: Write the shape fixture**

```js
// tests/fixtures/cli-mcp-shapes.js
// The native MCP entries each coding CLI accepts, per transport and auth. Pinned against
// the installed CLIs by tests/integration/cli-mcp-contract.test.js (claude 2.1.296,
// codex 0.160.1, opencode 1.18.35) and produced by nativeMcp()
// (tests/unit/cli-mcp-native.test.js). Values are fixtures, never real secrets.
export const url = "https://mcp.example.test/mcp";
export const command = "/usr/bin/true";
const none = { headers: {}, env: {} };
const header = { headers: { Authorization: "Bearer header-value" }, env: {} };
const stdio = (cwd = null) => ({
  transport: "stdio",
  command,
  args: ["--flag"],
  cwd,
  auth: "headers",
  oauthScope: null,
});
const remote = (transport, auth = "headers", oauthScope = null) => ({
  transport,
  url,
  args: [],
  cwd: null,
  auth,
  oauthScope,
});

export const cases = [
  {
    id: "stdio",
    central: stdio(),
    secrets: { headers: {}, env: { TOKEN: "env-value" } },
    native: {
      claude: { type: "stdio", command, args: ["--flag"], env: { TOKEN: "env-value" } },
      codex: { command, args: ["--flag"], env: { TOKEN: "env-value" } },
      opencode: {
        type: "local",
        command: [command, "--flag"],
        environment: { TOKEN: "env-value" },
        enabled: true,
      },
    },
  },
  {
    id: "stdio-cwd",
    central: stdio("/tmp"),
    secrets: none,
    native: { codex: { command, args: ["--flag"], env: {}, cwd: "/tmp" } },
    unsupported: { claude: "cwd", opencode: "cwd" },
  },
  {
    id: "http",
    central: remote("http"),
    secrets: header,
    native: {
      claude: { type: "http", url, headers: header.headers },
      codex: { url, http_headers: header.headers },
      opencode: { type: "remote", url, headers: header.headers, enabled: true },
    },
  },
  {
    id: "sse",
    central: remote("sse"),
    secrets: header,
    native: {
      claude: { type: "sse", url, headers: header.headers },
      opencode: { type: "remote", url, headers: header.headers, enabled: true },
    },
    unsupported: { codex: "transport" },
  },
  {
    id: "http-oauth",
    central: remote("http", "oauth", "read write"),
    secrets: none,
    native: {
      claude: { type: "http", url },
      codex: { url, scopes: ["read", "write"] },
      opencode: { type: "remote", url, oauth: { scope: "read write" }, enabled: true },
    },
  },
  {
    id: "sse-oauth",
    central: remote("sse", "oauth"),
    secrets: none,
    native: {
      claude: { type: "sse", url },
      opencode: { type: "remote", url, oauth: {}, enabled: true },
    },
    unsupported: { codex: "transport" },
  },
];

// `auth_status` of `codex mcp list --json` for an OAuth server, logged in or not.
export const codexAuthStatus = { loggedIn: "o_auth", loggedOut: "not_logged_in" };
```

- [ ] **Step 3: Write the contract helpers**

```js
// tests/helpers/cli-contract.js
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { detectTools } from "../../server/features/accounts/account-store.js";
import { toolBinDirectories } from "../../server/features/tools/tool-paths.js";

const execute = promisify(execFile);

/**
 * The installed coding CLIs by id, or null. `AGENTPIER_CLI_CONTRACT_DATA_DIR` names an
 * AgentPier data directory whose `clis/<tool>/bin` holds managed installs (OpenCode
 * lives there); PATH and the usual user bin directories are searched too. Only
 * executables are located: no configuration of the owner is read.
 */
export function installedClis() {
  const found = detectTools(
    process.env,
    true,
    toolBinDirectories(process.env.AGENTPIER_CLI_CONTRACT_DATA_DIR),
  );
  return Object.fromEntries(
    ["claude", "codex", "opencode"].map((id) => [
      id,
      found.find((tool) => tool.id === id && tool.installed)?.path ?? null,
    ]),
  );
}

/** A throwaway HOME holding every CLI configuration, data and cache location. */
export function isolatedHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-cli-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  if (path.resolve(home) === path.resolve(os.homedir()))
    throw new Error("Refusing to run a CLI contract in the owner's HOME.");
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    TERM: "dumb",
    NO_COLOR: "1",
  };
  return { root, home, env };
}

/** Runs one CLI command and returns its plain text output, whatever its exit code. */
export async function run(bin, args, env, { timeout = 90000 } = {}) {
  try {
    const { stdout, stderr } = await execute(bin, args, {
      env,
      cwd: env.HOME,
      timeout,
      maxBuffer: 4 << 20,
    });
    return { code: 0, stdout, text: stripVTControlCharacters(`${stdout}\n${stderr}`) };
  } catch (error) {
    if (error.killed) throw error;
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      text: stripVTControlCharacters(`${error.stdout ?? ""}\n${error.stderr ?? ""}`),
    };
  }
}

/** Codex keeps MCP OAuth tokens in a file inside the isolated HOME, never the keychain. */
export const codexArgs = (...args) => [
  "-c",
  'mcp_oauth_credentials_store="file"',
  ...args,
];
```

```js
// tests/helpers/mcp-sse-server.js
import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { echoServer } from "./mcp-test-servers.js";

/**
 * A legacy HTTP+SSE MCP server on 127.0.0.1 with the `echo` tool: GET /sse opens the
 * stream, POST /messages?sessionId= carries requests.
 */
export async function sseMcpServer() {
  const transports = new Map();
  const state = { connections: 0 };
  const listener = http.createServer(async (req, res) => {
    const address = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && address.pathname === "/sse") {
      state.connections++;
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => transports.delete(transport.sessionId));
      await echoServer("sse-echo", () => {}).connect(transport);
      return;
    }
    if (req.method === "POST" && address.pathname === "/messages") {
      const transport = transports.get(address.searchParams.get("sessionId"));
      if (!transport) return res.writeHead(404).end();
      return transport.handlePostMessage(req, res);
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${listener.address().port}/sse`,
    state,
    close: () =>
      new Promise((resolve) => {
        listener.closeAllConnections();
        listener.close(resolve);
      }),
  };
}
```

- [ ] **Step 4: Write the contract**

```js
// tests/integration/cli-mcp-contract.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { cases, codexAuthStatus, command, url } from "../fixtures/cli-mcp-shapes.js";
import { codexArgs, installedClis, isolatedHome, run } from "../helpers/cli-contract.js";
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
    const { home, env } = isolatedHome(t);
    const entries = live("claude", await liveServers(t));
    const file = path.join(home, ".claude.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: entries }, null, 2), {
      mode: 0o600,
    });
    const list = await run(bins.claude, ["mcp", "list"], env);
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
  },
);

test(
  "Codex lists every written entry, keeps cwd, and has no SSE form",
  options("codex"),
  async (t) => {
    const { home, env } = isolatedHome(t);
    const servers = await liveServers(t);
    const entries = live("codex", servers);
    // Codex's only remote form is streamable HTTP, even for an SSE endpoint.
    entries["ap-sse-as-http"] = { url: servers.sse, http_headers: {} };
    const file = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, stringifyToml({ mcp_servers: entries }), { mode: 0o600 });
    const listed = JSON.parse(
      (await run(bins.codex, codexArgs("mcp", "list", "--json"), env)).stdout,
    );
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
    assert.deepEqual(parseToml(fs.readFileSync(file, "utf8")).mcp_servers, entries);
  },
);

test(
  "OpenCode lists every written entry and reaches SSE through remote",
  options("opencode"),
  async (t) => {
    const { home, env } = isolatedHome(t);
    const entries = live("opencode", await liveServers(t));
    const marker = path.join(home, "cwd-marker");
    // Not an MCP server: it only records the directory OpenCode starts it in.
    const probe = {
      type: "local",
      command: [
        process.execPath,
        "-e",
        "require('fs').writeFileSync(process.argv[1], process.cwd())",
        marker,
      ],
      cwd: "/tmp",
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
    for (const name of Object.keys(entries))
      assert.ok(lineOf(list.text, name), `${name}:\n${list.text}`);
    for (const name of ["ap-http", "ap-sse"])
      assert.match(lineOf(list.text, name), /connected/);
    if (fs.existsSync(marker)) assert.notEqual(fs.readFileSync(marker, "utf8"), "/tmp");
    const auth = await run(bins.opencode, ["mcp", "auth", "list"], env);
    assert.match(auth.text, /ap-http-oauth[\s\S]*?not authenticated/);
    const after = JSON.parse(fs.readFileSync(file, "utf8")).mcp;
    delete after["ap-cwd-probe"];
    assert.deepEqual(after, entries);
  },
);
```

- [ ] **Step 5: Run the contract**

Run: `AGENTPIER_CLI_MCP_CONTRACT=1 AGENTPIER_CLI_CONTRACT_DATA_DIR="$HOME/Library/Application Support/AgentPier" node --test tests/integration/cli-mcp-contract.test.js`
(On Linux the data directory is AgentPier's configured data directory.) The CLIs only ever see the temporary HOME.
Expected: 3 tests pass. If one fails because a CLI behaves differently, apply the gate at the top of this task. Without the variable: 3 tests skipped.

- [ ] **Step 6: Write the login brokering probe**

The probe answers the spec's option C question for each CLI: can a login be started by AgentPier and finished with a callback that arrives through AgentPier's origin (AgentPier then hands the callback URL to the CLI)? It drives each CLI's login in a pseudo-terminal against the local OAuth test server, plays the browser with `approve()`, pastes the callback URL back, and reports what happened. It asserts only that it stayed inside its temporary HOME; the results go to the qualification document. Claude Code gets `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` inside the temporary HOME (as AgentPier's managed accounts do, so its secure storage is separate from the owner's) and is logged out at the end; Codex stores tokens in a file; OpenCode in its XDG data directory.

```js
// tests/integration/cli-mcp-login-probe.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import pty from "node-pty";
import { stringify as stringifyToml } from "smol-toml";
import { codexArgs, installedClis, isolatedHome, run } from "../helpers/cli-contract.js";
import { approve, oauthMcpServer } from "../helpers/mcp-oauth-test-server.js";

// docs/cli-mcp-qualification.md ("OAuth login brokering") records the results.
const enabled = process.env.AGENTPIER_CLI_MCP_LOGIN_PROBE === "1";
const bins = enabled ? installedClis() : {};
const options = (cli) => ({
  skip: !enabled
    ? "set AGENTPIER_CLI_MCP_LOGIN_PROBE=1 to probe CLI OAuth logins in a temporary HOME"
    : !bins[cli] && `${cli} is not installed`,
  timeout: 300000,
});
// The address a brokered login would return to; never contacted.
const brokered = "https://agentpier.example.test/api/mcp-servers/cli-oauth/callback";

/**
 * Runs a login in a pseudo-terminal. Each new authorization URL goes to `answer`, whose
 * result (a callback URL or null) is typed back followed by Enter.
 */
function drive(bin, args, env, answer, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const child = pty.spawn(bin, args, {
      env,
      cwd: env.HOME,
      cols: 1000,
      rows: 50,
      name: "xterm",
    });
    let output = "";
    const seen = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve({ output: stripVTControlCharacters(output), urls: seen, timedOut: true });
    }, timeoutMs);
    child.onData(async (data) => {
      output += data;
      for (const [found] of stripVTControlCharacters(output).matchAll(
        /https?:\/\/\S+\/authorize\?\S+/g,
      )) {
        if (seen.includes(found)) continue;
        seen.push(found);
        const reply = await answer(new URL(found)).catch(
          (error) => `error:${error.message}`,
        );
        if (reply) child.write(`${reply}\r`);
      }
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve({ output: stripVTControlCharacters(output), urls: seen, exitCode });
    });
  });
}

/** What a run tells about brokering, without tokens: redirect target and outcome. */
const summary = (result, status) => ({
  redirectUris: result.urls.map((url) => new URL(url).searchParams.get("redirect_uri")),
  exitCode: result.exitCode ?? null,
  timedOut: !!result.timedOut,
  status,
});

/** The browser's part: approve, then hand back the callback with AgentPier's origin. */
const viaAgentPier = async (authorize) => {
  const callback = await approve(authorize.href);
  return `${brokered}${callback.search}`;
};
const direct = async (authorize) => (await approve(authorize.href)).href;

test(
  "Codex: login with a callback URL handed back through AgentPier",
  options("codex"),
  async (t) => {
    const { home, env } = isolatedHome(t);
    const oauth = await oauthMcpServer();
    t.after(() => oauth.close());
    const file = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      file,
      stringifyToml({ mcp_servers: { probe: { url: oauth.url } } }),
      { mode: 0o600 },
    );
    const status = async () =>
      JSON.parse(
        (await run(bins.codex, codexArgs("mcp", "list", "--json"), env)).stdout,
      ).find((e) => e.name === "probe")?.auth_status;
    const report = {};
    report.pasted = summary(
      await drive(
        bins.codex,
        codexArgs("mcp", "login", "probe", "--no-browser"),
        env,
        direct,
      ),
      await status(),
    );
    await run(bins.codex, codexArgs("mcp", "logout", "probe"), env);
    report.brokered = summary(
      await drive(
        bins.codex,
        [
          ...codexArgs("-c", `mcp_oauth_callback_url="${brokered}"`),
          "mcp",
          "login",
          "probe",
          "--no-browser",
        ],
        env,
        viaAgentPier,
      ),
      await status(),
    );
    t.diagnostic(JSON.stringify({ codex: report }));
    assert.ok(fs.readdirSync(home).length > 0);
  },
);

test(
  "Claude Code: login with a callback URL handed back through AgentPier",
  options("claude"),
  async (t) => {
    const { home, env } = isolatedHome(t);
    const oauth = await oauthMcpServer();
    t.after(() => oauth.close());
    const configDir = path.join(home, ".claude-config");
    fs.mkdirSync(configDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ mcpServers: { probe: { type: "http", url: oauth.url } } }),
      { mode: 0o600 },
    );
    // The secure-storage directory is what AgentPier's managed accounts use to keep
    // Claude Code's credentials apart (account-store.js environment()).
    const claudeEnv = {
      ...env,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir,
    };
    t.after(() => run(bins.claude, ["mcp", "logout", "probe"], claudeEnv));
    const status = async () =>
      lineStatus((await run(bins.claude, ["mcp", "get", "probe"], claudeEnv)).text);
    const report = {
      pasted: summary(
        await drive(
          bins.claude,
          ["mcp", "login", "probe", "--no-browser"],
          claudeEnv,
          direct,
        ),
        await status(),
      ),
    };
    await run(bins.claude, ["mcp", "logout", "probe"], claudeEnv);
    report.brokered = summary(
      await drive(
        bins.claude,
        ["mcp", "login", "probe", "--no-browser"],
        claudeEnv,
        viaAgentPier,
      ),
      await status(),
    );
    t.diagnostic(JSON.stringify({ claude: report }));
    assert.ok(fs.existsSync(path.join(configDir, ".claude.json")));
  },
);
const lineStatus = (text) =>
  text
    .split("\n")
    .find((line) => /Status:/.test(line))
    ?.trim() ?? null;

test(
  "OpenCode: login with a custom redirect and a callback through AgentPier",
  options("opencode"),
  async (t) => {
    const { home, env } = isolatedHome(t);
    const oauth = await oauthMcpServer();
    t.after(() => oauth.close());
    const file = path.join(home, ".config/opencode/opencode.jsonc");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const write = (oauthConfig) =>
      fs.writeFileSync(
        file,
        JSON.stringify({
          mcp: {
            probe: { type: "remote", url: oauth.url, oauth: oauthConfig, enabled: true },
          },
        }),
        { mode: 0o600 },
      );
    // No browser may open; OpenCode prints the URL it would have opened.
    const quiet = { ...env, BROWSER: "/usr/bin/true" };
    const status = async () =>
      lineOf((await run(bins.opencode, ["mcp", "auth", "list"], env)).text);
    write({});
    const report = {
      pasted: summary(
        await drive(bins.opencode, ["mcp", "auth", "probe"], quiet, direct),
        await status(),
      ),
    };
    await run(bins.opencode, ["mcp", "logout", "probe"], env);
    write({ redirectUri: brokered });
    report.brokered = summary(
      await drive(bins.opencode, ["mcp", "auth", "probe"], quiet, viaAgentPier),
      await status(),
    );
    t.diagnostic(JSON.stringify({ opencode: report }));
    assert.ok(fs.existsSync(file));
  },
);
const lineOf = (text) =>
  text
    .split("\n")
    .find((line) => /\bprobe\b/.test(line))
    ?.trim() ?? null;
```

- [ ] **Step 7: Run the probe and keep its report**

Run: `AGENTPIER_CLI_MCP_LOGIN_PROBE=1 AGENTPIER_CLI_CONTRACT_DATA_DIR="$HOME/Library/Application Support/AgentPier" node --test --test-reporter=spec tests/integration/cli-mcp-login-probe.test.js 2>&1 | tee /tmp/cli-mcp-login-probe.txt`
Expected: 3 tests pass and print one `# {"codex":…}`, `# {"claude":…}`, `# {"opencode":…}` diagnostic each. For a CLI, brokering **works** when `brokered.redirectUris` all equal `https://agentpier.example.test/api/mcp-servers/cli-oauth/callback` and `brokered.status` shows a completed login (Codex `o_auth`; Claude a `Status:` line with `Connected`; OpenCode a `probe` line with `authenticated` but not `not authenticated`). Otherwise it does **not** work for that CLI.

- [ ] **Step 8: Write the qualification document**

Create `docs/cli-mcp-qualification.md` with exactly these sections. The first four sections are already established by Steps 2–5; the last section is filled from the Step 7 report (one row per CLI: the observed redirect URIs, the observed status, and the verdict "works"/"does not work" by the rule in Step 7).

````markdown
# Central MCP servers in the coding CLIs: qualification

What AgentPier relies on when it writes central MCP servers into the native
configuration of Claude Code, Codex and OpenCode, and how to re-establish it after a
CLI update. Contracts: `tests/integration/cli-mcp-contract.test.js` and
`tests/integration/cli-mcp-login-probe.test.js`; both run the installed CLIs only in a
temporary HOME.

```sh
AGENTPIER_CLI_MCP_CONTRACT=1 AGENTPIER_CLI_CONTRACT_DATA_DIR=<AgentPier data dir> \
  node --test tests/integration/cli-mcp-contract.test.js
AGENTPIER_CLI_MCP_LOGIN_PROBE=1 AGENTPIER_CLI_CONTRACT_DATA_DIR=<AgentPier data dir> \
  node --test tests/integration/cli-mcp-login-probe.test.js
```

Qualified versions: Claude Code 2.1.296, Codex 0.160.1, OpenCode 1.18.35.

## Native entries

`tests/fixtures/cli-mcp-shapes.js` is the source of truth; `nativeMcp()` produces it.

| Server             | Claude Code (`~/.claude.json` `mcpServers`) | Codex (`~/.codex/config.toml` `mcp_servers`) | OpenCode (`opencode.json(c)` `mcp`)                        |
| ------------------ | ------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| stdio              | `{type:"stdio",command,args,env}`           | `{command,args,env[,cwd]}`                   | `{type:"local",command:[cmd,...args],environment,enabled}` |
| HTTP, headers      | `{type:"http",url,headers}`                 | `{url,http_headers}`                         | `{type:"remote",url,headers,enabled}`                      |
| SSE, headers       | `{type:"sse",url,headers}`                  | none (no SSE)                                | `{type:"remote",url,headers,enabled}`                      |
| HTTP or SSE, OAuth | `{type:"http"\|"sse",url}`                  | `{url[,scopes:[...]]}` (HTTP only)           | `{type:"remote",url,oauth:{[scope]},enabled}`              |

## Support

- Claude Code: stdio, HTTP, SSE. A stdio `cwd` is not in its schema (`claude mcp add-json` drops it), so a server with a working directory cannot be bound.
- Codex: stdio (with `cwd`) and streamable HTTP. There is no SSE form; an SSE endpoint written as `url` is treated as streamable HTTP. SSE servers cannot be bound.
- OpenCode: stdio (`local`) and `remote`; `remote` reaches SSE servers (it falls back from streamable HTTP to SSE). It does not start a local command in a configured `cwd`, so a server with a working directory cannot be bound.
- Claude Code rewrites `~/.claude.json` on every start but keeps `mcpServers` entries as written; the TOML and JSONC files keep entries as written. Entry hashes therefore stay stable.

## Listing and OAuth status

- `claude mcp list` (text, health-checks each server): `<name>: <url> (HTTP|SSE) - <status>`; an OAuth server without a login shows a status asking for authentication. No machine-readable output: AgentPier shows the login hint "run `/mcp`".
- `codex mcp list --json`: one object per server with `transport.type` (`stdio`, `streamable_http`) and `auth_status` (`o_auth` logged in, `not_logged_in`, `bearer_token`, `unsupported`, `unknown`). AgentPier reads OAuth status from here.
- `opencode mcp list` and `opencode mcp auth list` (text): status per server, `authenticated`/`not authenticated` for OAuth servers. No machine-readable output: AgentPier shows the hint `opencode mcp auth <name>`.

## OAuth login brokering

AgentPier brokers agent logins by receiving the provider's callback on its own origin.
For the CLIs the probe starts each login with the authorization URL printed instead of
a browser, approves it, and hands the callback URL back to the CLI, once directly and
once rewritten to AgentPier's origin (with the CLI's custom-redirect setting where one
exists: Codex `mcp_oauth_callback_url`, OpenCode `oauth.redirectUri`; Claude Code has
only `--callback-port`).

| CLI         | Redirect URIs requested | Status after the brokered login | Brokering |
| ----------- | ----------------------- | ------------------------------- | --------- |
| Claude Code | (from the probe report) | (from the probe report)         | (verdict) |
| Codex       | (from the probe report) | (from the probe report)         | (verdict) |
| OpenCode    | (from the probe report) | (from the probe report)         | (verdict) |

Brokered CLI logins are a separate follow-up task, only for the CLIs marked "works".
Until then AgentPier shows each CLI's own login command.
````

Replace each "(from the probe report)" and "(verdict)" cell with the observed value from `/tmp/cli-mcp-login-probe.txt` before committing; no cell keeps parentheses.

- [ ] **Step 9: Format, lint and commit**

Run: `npx prettier --write tests/fixtures/cli-mcp-shapes.js tests/helpers/cli-contract.js tests/helpers/mcp-sse-server.js tests/integration/cli-mcp-contract.test.js tests/integration/cli-mcp-login-probe.test.js docs/cli-mcp-qualification.md && npx eslint tests/fixtures tests/helpers/cli-contract.js tests/helpers/mcp-sse-server.js tests/integration/cli-mcp-*.test.js && npm run check:structure`
Expected: no errors.

```bash
git add tests/fixtures/cli-mcp-shapes.js tests/helpers/cli-contract.js tests/helpers/mcp-sse-server.js tests/integration/cli-mcp-contract.test.js tests/integration/cli-mcp-login-probe.test.js docs/cli-mcp-qualification.md
git commit -m "test: pin native MCP entries of the coding CLIs and probe brokered logins

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The central list without agents

Today `McpServerStore`, its routes and the Accounts section exist only while the agent feature is enabled (`server/application/assistant-graph.js:145`, `server/http/routes/assistants.js:23`, `web/features/accounts/AccountsPage.jsx:58-65`). Once the central list replaces the MCP part of the CLI extensions, an owner without agents would lose MCP management. **Ruling:** the store becomes a core service; create, edit and delete work without agents through a small facade, and only the agent OAuth login routes stay behind the agent gate.

**Files:**

- Create: `server/features/mcp-servers/stdio-confirmation.js`
- Create: `server/features/mcp-servers/central-changes.js`
- Modify: `server/features/assistants/mcp-changes.js:16-32,148-158` (shared stdio confirmation)
- Modify: `server/application/services.js:~180` (core store and facade), `server/application/assistant-graph.js:145`, `server/application/assistants.js:105-121`, `server/application/shutdown.js:~36`
- Modify: `server/http/routes/mcp-servers.js` (whole file), `server/http/routes/assistants.js:23,87`, `server/app.js:~229`
- Modify: `web/features/accounts/AccountsPage.jsx:58-65`, `web/features/mcp-servers/McpServersSettings.jsx:88,152-206`
- Test: `tests/unit/mcp-central-changes.test.js`, `tests/blackbox/mcp-servers-without-agents.test.js`, `tests/browser/mcp-cli-bindings.spec.js`

**Interfaces:**

- Consumes: `McpServerStore` (`list`, `get`, `create`, `update`, `remove`, `previewUpdate`, `oauthMemory`, `deferLogout`, `definitions`), `McpChanges` (`create`, `update`, `remove`, as merged by PR #229), `assistantProblem(code, status)`.
- Produces:
  - `STDIO_CONFIRMATION_REQUIRED`, `requireStdioConfirmation(confirmed)`, `changesStdio(current, patch)` from `server/features/mcp-servers/stdio-confirmation.js`.
  - `class CentralMcpChanges({ servers, agents = () => null, maintenance = () => false, onSaved = async () => {} })` with `list()`, `create(input, { confirmStdio })` → public server, `update(id, input, { confirmStdio })` → `{ server, pending, logoutDeferred, stdioChanged }`, `remove(id)` → `{ pending, logoutDeferred, transport }`.
  - `services.mcpServers` (`McpServerStore | null`) and `services.mcpServerChanges` (`CentralMcpChanges | null`).
  - `mcpServerRoutes(services)` mounted as a core router; `mcpServerErrors` error middleware exported from `server/http/routes/mcp-servers.js`.
  - `McpServersSettings({ oauthResult, agentsEnabled })`.

- [ ] **Step 1: Rebase onto main with PR #229**

Run: `git fetch origin && git rebase origin/main && grep -n "auditMcp" server/http/routes/mcp-servers.js`
Expected: the rebase succeeds and `auditMcp` is found (PR #229 is in `main`). If it is not found, stop and ask.

- [ ] **Step 2: Write the failing facade tests**

```js
// tests/unit/mcp-central-changes.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";

function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-central-"));
  const servers = new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    exists: (f) => f.startsWith("/fake/"),
  });
  t.after(() => {
    servers.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const saved = [];
  const changes = new CentralMcpChanges({
    servers,
    onSaved: async () => saved.push(true),
    ...options,
  });
  return { servers, changes, saved };
}
const oauth = {
  name: "docs",
  transport: "http",
  url: "https://mcp.example.test/mcp",
  auth: "oauth",
};

test("without agents the store changes directly and every save reaches onSaved", async (t) => {
  const { servers, changes, saved } = setup(t);
  const created = await changes.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp",
  });
  const { server, pending, logoutDeferred, stdioChanged } = await changes.update(
    created.id,
    { revision: 1, name: "docs2" },
  );
  assert.equal(server.name, "docs2");
  assert.deepEqual([pending, logoutDeferred, stdioChanged], [false, false, false]);
  assert.deepEqual(await changes.remove(created.id), {
    pending: false,
    logoutDeferred: false,
    transport: "http",
  });
  assert.deepEqual(servers.list(), []);
  assert.equal(saved.length, 3);
});

test("without agents a stdio server still needs the owner's confirmation", async (t) => {
  const { servers, changes, saved } = setup(t);
  const stdio = { name: "local", transport: "stdio", command: "/fake/bin/server" };
  await assert.rejects(changes.create(stdio), {
    code: "MCP_STDIO_CONFIRMATION_REQUIRED",
  });
  assert.deepEqual(servers.list(), []);
  const created = await changes.create(stdio, { confirmStdio: true });
  await assert.rejects(changes.update(created.id, { revision: 1, args: ["x"] }), {
    code: "MCP_STDIO_CONFIRMATION_REQUIRED",
  });
  const { stdioChanged } = await changes.update(
    created.id,
    { revision: 1, args: ["x"] },
    { confirmStdio: true },
  );
  assert.equal(stdioChanged, true);
  assert.equal(saved.length, 2);
});

test("without agents a renamed or deleted OAuth server leaves a deferred logout", async (t) => {
  const { servers, changes } = setup(t);
  const created = await changes.create(oauth);
  servers.rememberOAuth(created.id, { connected: true });
  const { logoutDeferred } = await changes.update(created.id, {
    revision: 1,
    name: "renamed",
  });
  assert.equal(logoutDeferred, true);
  assert.deepEqual(servers.deferredLogouts(), [
    { name: "docs", url: oauth.url, transport: "http" },
  ]);
  assert.equal((await changes.remove(created.id)).logoutDeferred, true);
  assert.equal(servers.deferredLogouts().length, 2);
});

test("with agents every change goes through McpChanges; maintenance refuses changes", async (t) => {
  const calls = [];
  const agents = {
    create: async (input, options) => (
      calls.push(["create", input.name, options]),
      { id: "a" }
    ),
    update: async (id) => (
      calls.push(["update", id]),
      { server: { id }, pending: true, logoutDeferred: false, stdioChanged: false }
    ),
    remove: async (id) => (
      calls.push(["remove", id]),
      { pending: false, logoutDeferred: false, transport: "http" }
    ),
  };
  let maintenance = false;
  const { changes, saved } = setup(t, {
    agents: () => agents,
    maintenance: () => maintenance,
  });
  await changes.create({ name: "docs" }, { confirmStdio: true });
  await changes.update("a", { revision: 1 });
  await changes.remove("a");
  assert.deepEqual(calls, [
    ["create", "docs", { confirmStdio: true }],
    ["update", "a"],
    ["remove", "a"],
  ]);
  assert.equal(saved.length, 3);
  maintenance = true;
  await assert.rejects(changes.create({ name: "docs" }), { status: 409 });
  assert.equal(calls.length, 3);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/unit/mcp-central-changes.test.js`
Expected: FAIL with `Cannot find module '…/central-changes.js'`.

- [ ] **Step 4: Move the stdio confirmation into the MCP server feature**

```js
// server/features/mcp-servers/stdio-confirmation.js
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

export const STDIO_CONFIRMATION_REQUIRED = "MCP_STDIO_CONFIRMATION_REQUIRED";
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** Refuses a stdio server the owner has not confirmed; nothing is persisted then. */
export function requireStdioConfirmation(confirmed) {
  if (!confirmed)
    throw Object.assign(
      problem(serverMessages.mcpServers.stdioConfirmationRequired, 409),
      {
        code: STDIO_CONFIRMATION_REQUIRED,
      },
    );
}

/** Whether a patch alters what a stdio server runs: command, arguments, cwd or env. */
export function changesStdio(current, patch) {
  if (current.transport !== "stdio" || !record(patch)) return false;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (
    (patch.command !== undefined && patch.command !== current.command) ||
    (patch.args !== undefined && !same(patch.args, current.args)) ||
    (patch.cwd !== undefined && (patch.cwd || null) !== (current.cwd || null)) ||
    (record(patch.env) && Object.keys(patch.env).length > 0)
  );
}
```

In `server/features/assistants/mcp-changes.js`, delete the local `STDIO_CONFIRMATION_REQUIRED` constant and `requireStdioConfirmation` function (lines 17 and 26-32), add at the imports:

```js
import {
  STDIO_CONFIRMATION_REQUIRED,
  changesStdio as stdioChange,
  requireStdioConfirmation,
} from "../mcp-servers/stdio-confirmation.js";

export { STDIO_CONFIRMATION_REQUIRED };
```

and replace the body of the `changesStdio(current, patch)` method (lines 148-158) with:

```js
  /** Whether a patch alters what a stdio server runs: command, arguments, cwd or env. */
  changesStdio(current, patch) {
    return stdioChange(current, patch);
  }
```

- [ ] **Step 5: Write the facade**

```js
// server/features/mcp-servers/central-changes.js
import { assistantProblem } from "../assistants/assistant-validation.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { changesStdio, requireStdioConfirmation } from "./stdio-confirmation.js";

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The owner's central MCP servers, with or without agents. With agents each change
 * goes through McpChanges (admission, OpenClaw logouts, live apply). Without them the
 * store changes directly; a login OpenClaw may still hold under a server's old name or
 * address becomes a deferred logout, which the next Gateway start drains before it
 * compiles. `onSaved` runs after every stored change (the CLI reconciliation).
 */
export class CentralMcpChanges {
  constructor({
    servers,
    agents = () => null,
    maintenance = () => false,
    onSaved = async () => {},
  }) {
    Object.assign(this, { servers, agents, maintenance, onSaved });
  }
  list() {
    return this.servers.list();
  }
  /** Agents in maintenance refuse changes, as their routes always did. */
  admit() {
    if (this.maintenance()) throw assistantProblem("active", 409);
    return this.agents();
  }
  async create(input, options = {}) {
    const agents = this.admit();
    let server;
    if (agents) server = await agents.create(input, options);
    else {
      if (record(input) && input.transport === "stdio")
        requireStdioConfirmation(options.confirmStdio === true);
      server = this.servers.create(input);
    }
    await this.onSaved();
    return server;
  }
  async update(id, input, options = {}) {
    const agents = this.admit();
    const result = agents
      ? await agents.update(id, input, options)
      : this.updateDirect(id, input, options);
    await this.onSaved();
    return result;
  }
  async remove(id) {
    const agents = this.admit();
    const result = agents ? await agents.remove(id) : this.removeDirect(id);
    await this.onSaved();
    return result;
  }
  updateDirect(id, input, { confirmStdio = false } = {}) {
    const stdioChanged = changesStdio(this.servers.get(id), input);
    if (stdioChanged) requireStdioConfirmation(confirmStdio === true);
    const { before, after } = this.servers.previewUpdate(id, input);
    const orphaned =
      before.auth === "oauth" &&
      !(
        after.auth === "oauth" &&
        before.name === after.name &&
        before.url === after.url
      ) &&
      this.servers.oauthMemory(id).everConnected;
    const server = this.servers.update(id, input);
    if (orphaned) this.servers.deferLogout(before);
    return { server, pending: false, logoutDeferred: orphaned, stdioChanged };
  }
  removeDirect(id) {
    const definition = this.servers.definitions().find((item) => item.id === id);
    if (!definition) throw problem(serverMessages.mcpServers.notFound, 404);
    const orphaned =
      definition.transport !== "stdio" &&
      definition.auth === "oauth" &&
      this.servers.oauthMemory(id).everConnected;
    this.servers.remove(id);
    if (orphaned) this.servers.deferLogout(definition);
    return { pending: false, logoutDeferred: orphaned, transport: definition.transport };
  }
}
```

- [ ] **Step 6: Run the facade tests**

Run: `node --test tests/unit/mcp-central-changes.test.js tests/unit/mcp-oauth-lifecycle.test.js tests/unit/mcp-server-store.test.js`
Expected: PASS.

- [ ] **Step 7: Write the failing blackbox test**

```js
// tests/blackbox/mcp-servers-without-agents.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

test("the central MCP list works without agents; agent OAuth logins stay gated", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  assert.equal((await (await f.request("/api/assistant-feature")).json()).enabled, false);
  const created = await f.request("/api/mcp-servers", {
    method: "POST",
    body: {
      name: "docs",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer header-secret" },
    },
  });
  assert.equal(created.status, 201);
  const server = await created.json();
  const listed = await (await f.request("/api/mcp-servers")).json();
  assert.deepEqual(
    listed.map((s) => s.name),
    ["docs"],
  );
  const updated = await f.request(`/api/mcp-servers/${server.id}`, {
    method: "PUT",
    body: { revision: 1, name: "docs2" },
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).name, "docs2");
  const login = await f.request(`/api/mcp-servers/${server.id}/oauth/login`, {
    method: "POST",
    body: {},
  });
  assert.equal(login.status, 404);
  assert.equal((await login.json()).code, "ASSISTANTS_DISABLED");
  assert.equal(
    (await f.request(`/api/mcp-servers/${server.id}`, { method: "DELETE" })).status,
    204,
  );
  const audit = JSON.stringify(await (await f.request("/api/audit")).json());
  assert.match(audit, /mcp\.created/);
  assert.doesNotMatch(audit, /header-secret/);
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `node --test tests/blackbox/mcp-servers-without-agents.test.js`
Expected: FAIL — `POST /api/mcp-servers` answers 404 `ASSISTANTS_DISABLED`.

- [ ] **Step 9: Make the store and the facade core services**

In `server/application/services.js` add the imports

```js
import { McpServerStore } from "../features/mcp-servers/mcp-server-store.js";
import { CentralMcpChanges } from "../features/mcp-servers/central-changes.js";
```

and right after `const onError = () => { … };` (the operations-event warning handler) insert:

```js
// The central MCP servers exist with or without agents; a store that cannot be
// opened leaves the list unavailable (503) instead of stopping AgentPier.
let mcpServers = null;
try {
  mcpServers = new McpServerStore({ dataDir: config.dataDir });
} catch {
  console.error("AgentPier could not open the MCP server store.");
  operationalWarnings.add("mcp-servers-storage");
}
const mcpServerChanges =
  mcpServers &&
  new CentralMcpChanges({
    servers: mcpServers,
    agents: () => services.assistantMcpChanges,
    maintenance: () => !!services.assistants?.maintenance,
  });
```

and add `mcpServers, mcpServerChanges,` to the `services` object literal (next to `extensions,`).

In `server/application/assistant-graph.js:145` replace

```js
const assistantMcpServers = (created.mcpServers = new McpServerStore({ dataDir }));
```

with

```js
// The core store when AgentPier has one; it outlives the agent feature.
const assistantMcpServers =
  host.mcpServers || (created.mcpServers = new McpServerStore({ dataDir }));
```

In `server/application/assistants.js` `release()` replace

```js
try {
  assistantMcpServers?.close();
} catch {}
```

with

```js
// The core store stays open for the central list; only a private one is closed.
try {
  if (assistantMcpServers !== services.mcpServers) assistantMcpServers?.close();
} catch {}
```

In `server/application/shutdown.js`, after `await extensions.close();` add:

```js
try {
  services.mcpServers?.close();
} catch {}
```

- [ ] **Step 10: Serve the list outside the agent gate**

Replace `server/http/routes/mcp-servers.js` with the following (PR #229's `auditMcp` calls are kept; only the service lookup, the OAuth routes and the error boundary move):

```js
import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { STDIO_CONFIRMATION_REQUIRED } from "../../features/mcp-servers/stdio-confirmation.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";

/** A saved change whose OAuth logout is retried later (see McpOAuthLogins.forget). */
function deferredWarning() {
  const message = serverMessages.mcpServers.oauthLogoutDeferred;
  return { code: "oauth-logout-deferred", error: message, ...messageIdentity(message) };
}

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Answers a stdio server the owner has not confirmed with 409 and a stable code;
 * returns false for any other error.
 */
export function replyStdioConfirmation(response, error) {
  if (error?.code !== STDIO_CONFIRMATION_REQUIRED) return false;
  response.status(409).json({
    code: error.code,
    error: error.message,
    ...messageIdentity(error.message),
  });
  return true;
}

/**
 * Validation, conflicts and a busy Gateway keep their reason; storage and runtime
 * errors can carry private details.
 */
export const mcpServerErrors = (error, _req, _res, next) =>
  next(
    Number.isInteger(error.status) && error.status < 500 && !error.answered
      ? error
      : assistantProblem("unavailable", 503),
  );

/**
 * The owner's central MCP servers, served with or without agents (agent OAuth logins
 * stay under the assistant routes). Responses carry header and environment names
 * only and URLs without query or fragment; values never leave the store.
 */
export function mcpServerRoutes(services) {
  const { audit } = services;
  // Names and flags only: no header, env, argument, cwd or URL value is recorded.
  const auditMcp = (action, id, details) =>
    audit.append({
      action,
      resourceType: "mcp",
      resourceId: id,
      outcome: "success",
      source: "user",
      details,
    });
  const changes = () => {
    if (!services.mcpServerChanges) throw assistantProblem("unavailable", 503);
    return services.mcpServerChanges;
  };
  const router = Router();
  router.use("/mcp-servers", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // OAuth servers carry their agent login status (see McpOAuthLogins.decorate).
  router.get("/mcp-servers", async (_req, res) => {
    const list = changes().list();
    const oauth = services.assistantMcpOAuth;
    res.json(oauth ? await oauth.decorate(list) : list);
  });
  router.post("/mcp-servers", async (req, res) => {
    const body = req.body;
    const { confirmStdio, ...input } = record(body) ? body : {};
    let server;
    try {
      server = await changes().create(record(body) ? input : body, {
        confirmStdio: confirmStdio === true,
      });
    } catch (error) {
      if (replyStdioConfirmation(res, error)) return;
      throw error;
    }
    auditMcp("mcp.created", server.id, {
      transport: server.transport,
      stdioConfirmed: server.transport === "stdio" && confirmStdio === true,
    });
    res.status(201).json(server);
  });
  router.put("/mcp-servers/:id", async (req, res) => {
    const body = req.body;
    const { confirmStdio, ...input } = record(body) ? body : {};
    try {
      const { server, pending, logoutDeferred, stdioChanged } = await changes().update(
        req.params.id,
        record(body) ? input : body,
        { confirmStdio: confirmStdio === true },
      );
      auditMcp("mcp.updated", server.id, {
        transport: server.transport,
        fields: Object.keys(record(body) ? input : {}).filter(
          (key) => key !== "revision",
        ),
        stdioConfirmed: stdioChanged && confirmStdio === true,
      });
      res.json({
        ...server,
        ...(pending ? { pending: true } : {}),
        ...(logoutDeferred ? { oauthWarning: deferredWarning() } : {}),
      });
    } catch (error) {
      if (replyStdioConfirmation(res, error)) return;
      throw error;
    }
  });
  router.delete("/mcp-servers/:id", async (req, res) => {
    const { pending, logoutDeferred, transport } = await changes().remove(req.params.id);
    auditMcp("mcp.deleted", req.params.id, { transport });
    if (pending || logoutDeferred)
      res.json({
        ...(pending ? { pending: true } : {}),
        ...(logoutDeferred ? { oauthWarning: deferredWarning() } : {}),
      });
    else res.status(204).end();
  });
  router.use("/mcp-servers", mcpServerErrors);
  return router;
}
```

If PR #229 as merged differs from these `auditMcp` calls, keep the merged calls verbatim and change only `changes` to `changes()`.

In `server/http/routes/assistants.js` replace line 23 with

```js
// Agent OAuth logins of MCP servers exist only while the agent services do; the
// central list itself is a core route (mcp-servers.js).
const assistantPath = /^\/(?:assistants?(?:[-/]|$)|mcp-servers\/[^/]+\/oauth\/)/;
```

change the import on line 9 to `import { mcpServerErrors, replyStdioConfirmation } from "./mcp-servers.js";`, add `import { mcpOAuthRoutes } from "./mcp-oauth.js";`, and replace `router.use(mcpServerRoutes(services));` (line 87) with

```js
router.use(mcpOAuthRoutes(services));
router.use("/mcp-servers", mcpServerErrors);
```

In `server/app.js` import `mcpServerRoutes` from `./http/routes/mcp-servers.js` and add `mount(mcpServerRoutes(services));` on the line before `mount(assistantRoutes(services));`.

- [ ] **Step 11: Run the server tests**

Run: `node --test tests/blackbox/mcp-servers-without-agents.test.js tests/blackbox/mcp-server-routes.test.js tests/blackbox/mcp-oauth-routes.test.js tests/blackbox/mcp-server-audit.test.js tests/unit/assistant-wiring.test.js tests/integration/assistant-feature-dormant.test.js`
Expected: PASS.

- [ ] **Step 12: Write the failing browser test**

```js
// tests/browser/mcp-cli-bindings.spec.js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

/** The central MCP API; `state` records requests and holds what the list returns. */
async function setup(
  page,
  { language = "en", agents = false, servers = [], finds = [] } = {},
) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = {
    requests: [],
    servers: structuredClone(servers),
    finds: structuredClone(finds),
  };
  await page.route("**/api/assistant-feature", (route) =>
    route.fulfill({ json: { enabled: agents, error: null } }),
  );
  await page.route(/\/api\/mcp-servers/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    state.requests.push({ method: request.method(), path, body });
    if (path === "/api/mcp-servers" && request.method() === "GET")
      return route.fulfill({ json: state.servers });
    if (path === "/api/mcp-servers/cli-finds")
      return route.fulfill({ json: { finds: state.finds } });
    if (state.handle) {
      const handled = await state.handle({ route, request, path, body });
      if (handled !== false) return;
    }
    return route.fulfill({ status: 404, json: { error: "unexpected" } });
  });
  return state;
}

const header = (extra = {}) => ({
  id: "s1",
  name: "docs",
  transport: "http",
  url: "https://mcp.example.test/mcp",
  auth: "headers",
  headerNames: ["Authorization"],
  envNames: [],
  revision: 1,
  ...extra,
});

test("the central MCP list is on Accounts without agents and offers no agent login", async ({
  page,
}) => {
  await setup(page, { servers: [header({ auth: "oauth", headerNames: [] })] });
  await page.goto(baseURL + "/accounts");
  await expect(
    page.getByRole("heading", { name: "MCP servers", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("docs", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /log in/i })).toHaveCount(0);
});
```

- [ ] **Step 13: Run it to verify it fails**

Run: `npm run build && npx playwright test tests/browser/mcp-cli-bindings.spec.js --project=chromium`
Expected: FAIL — the heading "MCP servers" is not visible.

- [ ] **Step 14: Show the list without agents**

In `web/features/accounts/AccountsPage.jsx` replace lines 58-65 with:

```jsx
{
  agentsEnabled && (
    <Suspense fallback={null}>
      <AssistantModelAccounts navigate={onNavigate} />
      <SpeechSettings />
      <WebSearchSettings connections={state.providerConnections || []} />
    </Suspense>
  );
}
<Suspense fallback={null}>
  <McpServersSettings oauthResult={mcpOAuth} agentsEnabled={!!agentsEnabled} />
</Suspense>;
```

In `web/features/mcp-servers/McpServersSettings.jsx` change the signature to `export default function McpServersSettings({ oauthResult, agentsEnabled = true })`, add `const agentLogin = (server) => agentsEnabled && usesOAuth(server);` below the `names` helper inside the component, and replace the three uses `usesOAuth(server) && <McpOAuthStatus …>`, `usesOAuth(server) && <McpOAuthStatusHint …>` and `usesOAuth(server) && <McpOAuthActions …>` (lines 160, 163, 188) with `agentLogin(server) && …`. Agent logins exist only with agents; the OAuth details in `ServerDetails` stay.

- [ ] **Step 15: Run the browser test and the existing MCP specs**

Run: `npm run build && npx playwright test tests/browser/mcp-cli-bindings.spec.js tests/browser/mcp-oauth.spec.js tests/browser/agent-mcp-servers.spec.js --project=chromium`
Expected: PASS.

- [ ] **Step 16: Check and commit**

Run: `npm run lint && npm run format:check && npm run check:structure`
Expected: no errors.

```bash
git add server/features/mcp-servers/stdio-confirmation.js server/features/mcp-servers/central-changes.js server/features/assistants/mcp-changes.js server/application/services.js server/application/assistant-graph.js server/application/assistants.js server/application/shutdown.js server/http/routes/mcp-servers.js server/http/routes/assistants.js server/app.js web/features/accounts/AccountsPage.jsx web/features/mcp-servers/McpServersSettings.jsx tests/unit/mcp-central-changes.test.js tests/blackbox/mcp-servers-without-agents.test.js tests/browser/mcp-cli-bindings.spec.js
git commit -m "feat: keep the central MCP server list available without agents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Native projection, support matrix and entry hashes

Extends `nativeMcp()` with the SSE and OAuth forms and Codex's `cwd`, exactly as Task 1 pinned them, and adds the pure helpers every later task uses: which CLI supports which server, the canonical hash AgentPier records, parsing a native entry back into central fields, and valid name proposals. **Ruling (spec silent):** a stdio server with a working directory cannot be bound to Claude Code or OpenCode (neither starts a command in a configured directory, Task 1); it is refused like an unsupported transport, with the code `MCP_CLI_CWD_UNSUPPORTED`.

**Files:**

- Modify: `server/features/extensions/mcp-config.js:97-120` (`nativeMcp`), `:186-199` (`atomicText`)
- Create: `server/features/mcp-servers/cli-native.js`
- Test: `tests/unit/cli-mcp-native.test.js`, `tests/property/cli-mcp-native.test.js`

**Interfaces:**

- Consumes: `cases` from `tests/fixtures/cli-mcp-shapes.js` (Task 1); `record`, `values`, `mcpUrl` from `mcp-config.js`; `namePattern` from `command-resolution.js`.
- Produces:
  - `nativeMcp(tool, entry)` where `entry = { transport, url?, command?, args, env, headers, cwd?, auth?, oauthScope? }`.
  - `CLI_CONFIG_CHANGED = "CLI_CONFIG_CHANGED"`; `atomicText` throws its 409 problem with `code: CLI_CONFIG_CHANGED`.
  - From `cli-native.js`: `clis = ["claude", "codex", "opencode"]`; `cliSupport(cli, server) → { supported: true } | { supported: false, reason: "transport" | "cwd" }`; `cliInput(definition, secrets)`; `cliEntry(cli, definition, secrets)`; `canonicalJson(value)`; `entryHash(entry) → hex string`; `centralFromNative(cli, entry) → { ok: true, definition, secrets } | { ok: false, reason: "unsupported-fields" | "invalid", keys? }`; `contentKey(parsed) → string`; `proposeName(name, taken: Set<lowercase name>) → string`.

- [ ] **Step 1: Write the failing unit tests**

```js
// tests/unit/cli-mcp-native.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { cases } from "../fixtures/cli-mcp-shapes.js";
import {
  canonicalJson,
  centralFromNative,
  cliEntry,
  cliSupport,
  clis,
  contentKey,
  entryHash,
  proposeName,
} from "../../server/features/mcp-servers/cli-native.js";

test("every pinned native entry is exactly what AgentPier projects", () => {
  for (const item of cases)
    for (const cli of clis) {
      const support = cliSupport(cli, item.central);
      if (item.unsupported?.[cli]) {
        assert.deepEqual(
          support,
          { supported: false, reason: item.unsupported[cli] },
          `${item.id}/${cli}`,
        );
        continue;
      }
      assert.equal(support.supported, true, `${item.id}/${cli}`);
      assert.deepEqual(
        cliEntry(cli, item.central, item.secrets),
        item.native[cli],
        `${item.id}/${cli}`,
      );
    }
});

test("a pinned native entry parses back into the same projection", () => {
  for (const item of cases)
    for (const [cli, native] of Object.entries(item.native)) {
      const parsed = centralFromNative(cli, native);
      assert.equal(parsed.ok, true, `${item.id}/${cli}`);
      assert.deepEqual(
        cliEntry(cli, parsed.definition, parsed.secrets),
        native,
        `${item.id}/${cli}`,
      );
    }
});

test("identical content from different CLIs has one content key", () => {
  const http = cases.find((item) => item.id === "http").native;
  const keys = ["claude", "codex", "opencode"].map((cli) =>
    contentKey(centralFromNative(cli, http[cli])),
  );
  assert.equal(new Set(keys).size, 1);
  const other = centralFromNative("claude", {
    ...http.claude,
    url: "https://other.example.test/mcp",
  });
  assert.notEqual(contentKey(other), keys[0]);
});

test("entries AgentPier cannot represent are not adoptable, by reason", () => {
  assert.deepEqual(
    centralFromNative("codex", { url: "https://x.test/mcp", startup_timeout_sec: 5 }),
    {
      ok: false,
      reason: "unsupported-fields",
      keys: ["startup_timeout_sec"],
    },
  );
  assert.equal(
    centralFromNative("opencode", {
      type: "remote",
      url: "https://x.test/mcp",
      enabled: false,
    }).reason,
    "unsupported-fields",
  );
  assert.equal(
    centralFromNative("claude", { type: "ws", url: "wss://x.test" }).reason,
    "unsupported-fields",
  );
  assert.equal(
    centralFromNative("claude", { type: "http", url: "https://u:p@x.test/mcp" }).reason,
    "invalid",
  );
  assert.equal(centralFromNative("codex", { command: "" }).reason, "invalid");
  assert.equal(centralFromNative("claude", "not an object").reason, "invalid");
});

test("the hash is canonical: key order and absent keys do not matter, values do", () => {
  assert.equal(
    canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }),
    '{"a":[{"c":3,"d":2}],"b":1}',
  );
  assert.equal(entryHash({ a: 1, b: undefined }), entryHash({ a: 1 }));
  assert.equal(
    entryHash({ url: "u", headers: { A: "1" } }),
    entryHash({ headers: { A: "1" }, url: "u" }),
  );
  assert.notEqual(entryHash({ headers: { A: "1" } }), entryHash({ headers: { A: "2" } }));
  assert.match(entryHash({}), /^[0-9a-f]{64}$/);
});

test("name proposals are valid, free and keep a valid free name", () => {
  const taken = new Set(["docs", "docs-2"]);
  assert.equal(proposeName("search", taken), "search");
  assert.equal(proposeName("Docs", taken), "Docs-3");
  assert.equal(proposeName("my.server", taken), "my-server");
  assert.equal(proposeName("1password", taken), "password");
  assert.equal(proposeName("***", taken), "mcp");
  assert.equal(proposeName("a".repeat(40), taken), "a".repeat(30));
});
```

```js
// tests/property/cli-mcp-native.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  centralFromNative,
  cliEntry,
  entryHash,
  proposeName,
} from "../../server/features/mcp-servers/cli-native.js";
import { namePattern } from "../../server/features/mcp-servers/command-resolution.js";

const headerName = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,15}$/)
  .filter((name) => !["constructor", "prototype"].includes(name));
const headerValue = fc.stringMatching(/^[ -~]{0,40}$/);

test("any proposed name is valid and not taken", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 60 }),
      fc.array(fc.stringMatching(/^[a-z][a-z0-9_-]{0,29}$/), { maxLength: 20 }),
      (name, list) => {
        const taken = new Set(list);
        const proposed = proposeName(name, taken);
        assert.match(proposed, namePattern);
        assert.equal(taken.has(proposed.toLowerCase()), false);
      },
    ),
  );
});

test("an HTTP header server survives projection and parsing in every CLI", () => {
  fc.assert(
    fc.property(
      fc.dictionary(headerName, headerValue, { maxKeys: 5 }),
      fc.constantFrom("claude", "codex", "opencode"),
      (headers, cli) => {
        const definition = {
          transport: "http",
          url: "https://mcp.example.test/mcp?k=v",
          args: [],
          cwd: null,
          auth: "headers",
          oauthScope: null,
        };
        const native = cliEntry(cli, definition, { headers, env: {} });
        const parsed = centralFromNative(cli, native);
        assert.equal(parsed.ok, true);
        assert.equal(
          entryHash(cliEntry(cli, parsed.definition, parsed.secrets)),
          entryHash(native),
        );
      },
    ),
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/cli-mcp-native.test.js tests/property/cli-mcp-native.test.js`
Expected: FAIL with `Cannot find module '…/cli-native.js'`.

- [ ] **Step 3: Extend the native projection**

In `server/features/extensions/mcp-config.js` replace `nativeMcp` (lines 97-120) with:

```js
/**
 * A server in a CLI's native form (docs/cli-mcp-qualification.md). OAuth servers carry
 * no static headers: Claude Code and OpenCode run the login when the server asks,
 * Codex with `codex mcp login`. Only Codex knows a stdio working directory.
 */
export function nativeMcp(tool, entry) {
  if (entry.transport === "stdio") {
    if (tool === "opencode")
      return {
        type: "local",
        command: [entry.command, ...entry.args],
        environment: entry.env,
        enabled: true,
      };
    return {
      ...(tool === "claude" ? { type: "stdio" } : {}),
      command: entry.command,
      args: entry.args,
      env: entry.env,
      ...(tool === "codex" && entry.cwd ? { cwd: entry.cwd } : {}),
    };
  }
  const oauth = entry.auth === "oauth";
  // No header map at all when there are none: then a header server without headers
  // and an OAuth server read the same in Claude Code and Codex, as they behave.
  const headers =
    !oauth && Object.keys(entry.headers || {}).length ? entry.headers : null;
  if (tool === "codex") {
    if (!oauth) return { url: entry.url, ...(headers ? { http_headers: headers } : {}) };
    const scopes = (entry.oauthScope || "").split(/\s+/).filter(Boolean);
    return { url: entry.url, ...(scopes.length ? { scopes } : {}) };
  }
  if (tool === "claude")
    return {
      type: entry.transport === "sse" ? "sse" : "http",
      url: entry.url,
      ...(headers ? { headers } : {}),
    };
  return {
    type: "remote",
    url: entry.url,
    ...(oauth
      ? { oauth: entry.oauthScope ? { scope: entry.oauthScope } : {} }
      : headers
        ? { headers }
        : {}),
    enabled: true,
  };
}
```

In the same file add `export const CLI_CONFIG_CHANGED = "CLI_CONFIG_CHANGED";` below the imports and, in `atomicText`, replace

```js
throw problem(serverMessages.extensions.cliConfigChanged, 409);
```

with

```js
throw Object.assign(problem(serverMessages.extensions.cliConfigChanged, 409), {
  code: CLI_CONFIG_CHANGED,
});
```

- [ ] **Step 4: Write `cli-native.js`**

```js
// server/features/mcp-servers/cli-native.js
import { createHash } from "node:crypto";
import path from "node:path";
import { mcpUrl, nativeMcp, record, values } from "../extensions/mcp-config.js";
import { namePattern } from "./command-resolution.js";

/** The coding CLIs a central server can be bound to: the `cli` binding target ids. */
export const clis = ["claude", "codex", "opencode"];

/**
 * Whether `cli` can run `server` (a definition or a public server). Codex has no SSE;
 * only Codex starts a stdio command in a working directory
 * (docs/cli-mcp-qualification.md).
 */
export function cliSupport(cli, server) {
  if (cli === "codex" && server.transport === "sse")
    return { supported: false, reason: "transport" };
  if (cli !== "codex" && server.transport === "stdio" && server.cwd)
    return { supported: false, reason: "cwd" };
  return { supported: true };
}

/** nativeMcp's input for a stored definition and its secrets. */
export function cliInput(definition, secrets) {
  return {
    transport: definition.transport,
    url: definition.url ?? undefined,
    command: definition.command ?? undefined,
    args: definition.args ?? [],
    cwd: definition.cwd ?? null,
    auth: definition.auth ?? "headers",
    oauthScope: definition.oauthScope ?? null,
    headers: { ...secrets.headers },
    env: { ...secrets.env },
  };
}

export const cliEntry = (cli, definition, secrets) =>
  nativeMcp(cli, cliInput(definition, secrets));

/** JSON with keys sorted at every level and undefined members left out. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** What AgentPier records for a native entry: its hash, never the entry. */
export const entryHash = (entry) =>
  createHash("sha256").update(canonicalJson(entry)).digest("hex");

const extra = (entry, keys) => Object.keys(entry).filter((key) => !keys.includes(key));
const strings = (list) =>
  Array.isArray(list) && list.every((item) => typeof item === "string");
const unsupported = (keys) => ({ ok: false, reason: "unsupported-fields", keys });
const invalid = { ok: false, reason: "invalid" };
const fail = () => {
  throw new Error("invalid native MCP entry");
};

function stdio(command, args, env, cwd = null) {
  if (typeof command !== "string" || !command.trim() || !strings(args)) fail();
  if (cwd !== null && (typeof cwd !== "string" || !path.isAbsolute(cwd))) fail();
  return {
    ok: true,
    definition: {
      transport: "stdio",
      command,
      args,
      cwd,
      auth: "headers",
      oauthScope: null,
    },
    secrets: { headers: {}, env: { ...values(env ?? {}) } },
  };
}
/** `oauthScope` undefined: header auth; a string (possibly empty): OAuth. */
function remote(transport, url, headers, oauthScope) {
  if (typeof url !== "string") fail();
  mcpUrl(url);
  const oauth = oauthScope !== undefined;
  return {
    ok: true,
    definition: {
      transport,
      url,
      command: null,
      args: [],
      cwd: null,
      auth: oauth ? "oauth" : "headers",
      oauthScope: oauth && oauthScope ? oauthScope : null,
    },
    secrets: { headers: oauth ? {} : { ...values(headers ?? {}, true) }, env: {} },
  };
}
function fromClaude(entry) {
  const type = entry.type ?? (entry.command !== undefined ? "stdio" : undefined);
  if (type === "stdio") {
    const keys = extra(entry, ["type", "command", "args", "env"]);
    return keys.length
      ? unsupported(keys)
      : stdio(entry.command, entry.args ?? [], entry.env);
  }
  if (type === "http" || type === "sse") {
    const keys = extra(entry, ["type", "url", "headers"]);
    return keys.length ? unsupported(keys) : remote(type, entry.url, entry.headers);
  }
  return unsupported(["type"]);
}
function fromCodex(entry) {
  if (entry.enabled === false) return unsupported(["enabled"]);
  if (entry.command !== undefined) {
    const keys = extra(entry, ["command", "args", "env", "cwd", "enabled"]);
    return keys.length
      ? unsupported(keys)
      : stdio(entry.command, entry.args ?? [], entry.env, entry.cwd ?? null);
  }
  const keys = extra(entry, ["url", "http_headers", "scopes", "enabled"]);
  if (keys.length) return unsupported(keys);
  if (entry.scopes === undefined) return remote("http", entry.url, entry.http_headers);
  if (!strings(entry.scopes) || !entry.scopes.length || entry.http_headers !== undefined)
    return unsupported(["scopes"]);
  return remote("http", entry.url, {}, entry.scopes.join(" "));
}
function fromOpenCode(entry) {
  if (entry.enabled === false) return unsupported(["enabled"]);
  if (entry.type === "local") {
    const keys = extra(entry, ["type", "command", "environment", "enabled"]);
    if (keys.length) return unsupported(keys);
    if (!Array.isArray(entry.command) || !entry.command.length) fail();
    const [command, ...args] = entry.command;
    return stdio(command, args, entry.environment);
  }
  if (entry.type !== "remote") return unsupported(["type"]);
  const keys = extra(entry, ["type", "url", "headers", "oauth", "enabled"]);
  if (keys.length) return unsupported(keys);
  if (entry.oauth === undefined) return remote("http", entry.url, entry.headers);
  if (!record(entry.oauth) || extra(entry.oauth, ["scope"]).length || entry.headers)
    return unsupported(["oauth"]);
  if (entry.oauth.scope !== undefined && typeof entry.oauth.scope !== "string") fail();
  return remote("http", entry.url, {}, entry.oauth.scope ?? "");
}

/**
 * A native entry as central fields, `{ ok, definition, secrets }`, or `{ ok: false,
 * reason }` when AgentPier could not take it over without losing something: settings
 * it does not manage, a disabled entry, or malformed values. OpenCode's `remote` reads
 * as HTTP; it cannot tell SSE apart.
 */
export function centralFromNative(cli, entry) {
  if (!record(entry)) return invalid;
  try {
    if (cli === "claude") return fromClaude(entry);
    if (cli === "codex") return fromCodex(entry);
    return fromOpenCode(entry);
  } catch {
    return invalid;
  }
}

/** Equal for identical servers found in different CLIs; holds values, never leaves the server. */
export const contentKey = (parsed) =>
  canonicalJson({ ...parsed.definition, ...parsed.secrets });

/**
 * A valid central name close to `name` that `taken` (lower-case names) does not hold.
 * A valid free name is kept.
 */
export function proposeName(name, taken) {
  let base = String(name)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z]+/, "")
    .slice(0, 30);
  if (!base) base = "mcp";
  if (namePattern.test(base) && !taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 30 - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/unit/cli-mcp-native.test.js tests/property/cli-mcp-native.test.js tests/integration/extensions.test.js`
Expected: PASS (the extension tests still pass: stdio projections and remote servers with headers are unchanged; a remote server without headers no longer gets an empty header map).

- [ ] **Step 6: Check and commit**

Run: `npm run lint && npm run format:check && npm run check:structure`

```bash
git add server/features/extensions/mcp-config.js server/features/mcp-servers/cli-native.js tests/unit/cli-mcp-native.test.js tests/property/cli-mcp-native.test.js
git commit -m "feat: project central MCP servers into each CLI's native form

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: CLI bindings and entry records in the store

Adds the `cli` binding kind and the `cli_entries` table. Rows have no foreign key on purpose: a deleted or unbound server's row tells the reconciler which file entry to remove (store first, then file). **Ruling:** besides the spec's `hash`, a row carries `pending_hash`, the hash of a write recorded before the file was written; this is what lets the next run tell "AgentPier's interrupted write" from "a hand edit".

**Files:**

- Create: `server/features/mcp-servers/cli-entry-store.js`
- Modify: `server/features/mcp-servers/mcp-server-store.js:1-11,66-70,107-125,350-363` and append `targetsOf`/`setClis`
- Test: `tests/unit/mcp-server-store-cli.test.js`

**Interfaces:**

- Consumes: `clis` from `cli-native.js` (Task 3).
- Produces:
  - `class CliEntryStore(db, { now })`: `list(cli) → Row[]`, `get(serverId, cli) → Row | null`, `intend(serverId, cli, name, hash)`, `settle(serverId, cli, hash)`, `forget(serverId, cli)`, with `Row = { serverId, cli, name, hash, pendingHash, writtenAt }`.
  - `McpServerStore`: `cliEntries` (a `CliEntryStore`), `bind/unbind/bindings/bindingsByTarget` accept kind `"cli"` with ids from `clis`, `create(input, { bind: Array<[kind, targetId]> })`, `targetsOf(id) → { agents: string[], clis: string[] }`, `setClis(id, ids)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/mcp-server-store-cli.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";

function store(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-store-cli-"));
  const s = new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    exists: (f) => f.startsWith("/fake/"),
  });
  t.after(() => {
    s.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { s, dataDir };
}
const http = { name: "docs", transport: "http", url: "https://mcp.example.test/mcp" };

test("cli bindings accept exactly the three coding CLIs", (t) => {
  const { s } = store(t);
  const { id } = s.create(http);
  s.bind(id, "cli", "codex");
  s.setClis(id, ["claude", "codex", "claude"]);
  assert.deepEqual(s.bindings("cli", "claude"), [id]);
  assert.deepEqual(s.targetsOf(id), { agents: [], clis: ["claude", "codex"] });
  assert.throws(() => s.bind(id, "cli", "gemini"), { status: 400 });
  assert.throws(() => s.setClis(id, ["shell"]), { status: 400 });
  s.bind(id, "agent", "home");
  s.setClis(id, []);
  assert.deepEqual(s.targetsOf(id), { agents: ["home"], clis: [] });
});

test("create binds in the same transaction", (t) => {
  const { s } = store(t);
  const server = s.create(http, { bind: [["cli", "opencode"]] });
  assert.deepEqual(s.targetsOf(server.id).clis, ["opencode"]);
  assert.throws(() => s.create({ ...http, name: "other" }, { bind: [["cli", "nope"]] }), {
    status: 400,
  });
  assert.deepEqual(
    s.list().map((item) => item.name),
    ["docs"],
  );
});

test("entry records keep a pending write apart and survive their server", (t) => {
  const { s, dataDir } = store(t);
  const { id } = s.create(http);
  s.cliEntries.intend(id, "claude", "docs", "h1");
  assert.deepEqual(
    { ...s.cliEntries.get(id, "claude"), writtenAt: null },
    {
      serverId: id,
      cli: "claude",
      name: "docs",
      hash: null,
      pendingHash: "h1",
      writtenAt: null,
    },
  );
  s.cliEntries.settle(id, "claude", "h1");
  s.cliEntries.intend(id, "claude", "docs", "h2");
  assert.deepEqual(
    [s.cliEntries.get(id, "claude").hash, s.cliEntries.get(id, "claude").pendingHash],
    ["h1", "h2"],
  );
  // A new name drops the old hash: it belonged to the old entry.
  s.cliEntries.intend(id, "claude", "renamed", "h3");
  assert.equal(s.cliEntries.get(id, "claude").hash, null);
  s.remove(id);
  assert.equal(s.cliEntries.list("claude").length, 1);
  s.cliEntries.forget(id, "claude");
  assert.deepEqual(s.cliEntries.list("claude"), []);
  // The table is created in an existing database (the migration).
  s.close();
  const again = new McpServerStore({ dataDir });
  again.cliEntries.intend("x", "codex", "n", "h");
  assert.equal(again.cliEntries.list("codex").length, 1);
  again.close();
});
```

The last test closes `s` itself; change its `t.after` in `store()` to `try { s.close(); } catch {}` so the double close is harmless:

```js
t.after(() => {
  try {
    s.close();
  } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/mcp-server-store-cli.test.js`
Expected: FAIL — `bind(id, "cli", "codex")` throws 400 (`invalidTarget`).

- [ ] **Step 3: Write `CliEntryStore`**

```js
// server/features/mcp-servers/cli-entry-store.js
const schema = `
CREATE TABLE IF NOT EXISTS cli_entries(
  server_id TEXT NOT NULL,
  cli TEXT NOT NULL CHECK(cli IN ('claude','codex','opencode')),
  name TEXT NOT NULL, hash TEXT, pending_hash TEXT, written_at INTEGER,
  PRIMARY KEY(server_id, cli));`;

const row = (r) => ({
  serverId: r.server_id,
  cli: r.cli,
  name: r.name,
  hash: r.hash,
  pendingHash: r.pending_hash,
  writtenAt: r.written_at,
});

/**
 * The native entries AgentPier wrote into the CLIs: name and hashes, never the entry.
 * A row outlives its server or binding until the reconciler removed the file entry.
 * `pending_hash` is a write recorded before it reached the file.
 */
export class CliEntryStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
    db.exec(schema);
  }
  list(cli) {
    return this.db
      .prepare("SELECT * FROM cli_entries WHERE cli=? ORDER BY name, server_id")
      .all(cli)
      .map(row);
  }
  get(serverId, cli) {
    const found = this.db
      .prepare("SELECT * FROM cli_entries WHERE server_id=? AND cli=?")
      .get(serverId, cli);
    return found ? row(found) : null;
  }
  /** Records a write of `hash` under `name` before it happens; a new name drops the old hash. */
  intend(serverId, cli, name, hash) {
    this.db
      .prepare(
        `INSERT INTO cli_entries(server_id,cli,name,hash,pending_hash) VALUES (?,?,?,NULL,?)
         ON CONFLICT(server_id,cli) DO UPDATE SET
           hash=CASE WHEN name=excluded.name THEN hash ELSE NULL END,
           name=excluded.name, pending_hash=excluded.pending_hash`,
      )
      .run(serverId, cli, name, hash);
  }
  /** The file holds `hash` now. */
  settle(serverId, cli, hash) {
    this.db
      .prepare(
        "UPDATE cli_entries SET hash=?, pending_hash=NULL, written_at=? WHERE server_id=? AND cli=?",
      )
      .run(hash, this.now(), serverId, cli);
  }
  forget(serverId, cli) {
    this.db
      .prepare("DELETE FROM cli_entries WHERE server_id=? AND cli=?")
      .run(serverId, cli);
  }
}
```

- [ ] **Step 4: Teach the store the `cli` kind**

In `server/features/mcp-servers/mcp-server-store.js`:

- add the imports `import { CliEntryStore } from "./cli-entry-store.js";` and `import { clis } from "./cli-native.js";`;
- replace line 11 with `const targetKinds = ["agent", "cli"];`;
- replace the `target` helper (lines 66-70) with

```js
const target = (kind, id) => {
  if (!targetKinds.includes(kind)) throw invalid(messages.invalidTarget);
  if (typeof id !== "string" || !id || id.length > 200 || /[\x00-\x1f]/.test(id))
    throw invalid(messages.invalidTarget);
  if (kind === "cli" && !clis.includes(id)) throw invalid(messages.invalidTarget);
};
```

- at the end of the constructor (after the `oauth_login_redirect` migration) add

```js
// Which native CLI entries AgentPier wrote (cli-reconciler.js).
this.cliEntries = new CliEntryStore(this.db);
```

- replace `create(input)` with

```js
  /** `bind`: `[kind, targetId]` pairs bound in the same transaction. */
  create(input, { bind = [] } = {}) {
    const fields = this.definition(input);
    const id = randomUUID();
    this.transaction(() => {
      this.insertOrUpdate(
        "INSERT INTO servers(name,transport,url,command,args,cwd,auth,oauth_scope,revision,id) VALUES (?,?,?,?,?,?,?,?,?,?)",
        fields,
        id,
        1,
      );
      this.writeSecrets(id, input, fields.transport, true, fields.auth);
      for (const [kind, targetId] of bind) this.bind(id, kind, targetId);
    });
    return this.get(id);
  }
```

- append before the class's closing brace

```js
  /** `{ agents, clis }`: the targets server `id` is bound to. */
  targetsOf(id) {
    const out = { agents: [], clis: [] };
    for (const r of this.db
      .prepare(
        "SELECT target_kind, target_id FROM bindings WHERE server_id=? ORDER BY target_id",
      )
      .all(id))
      out[r.target_kind === "cli" ? "clis" : "agents"].push(r.target_id);
    return out;
  }
  /** Replaces the CLI bindings of server `id` with `ids`. */
  setClis(id, ids) {
    if (!Array.isArray(ids)) throw invalid();
    for (const cli of ids) target("cli", cli);
    this.transaction(() => {
      this.row(id);
      this.db.prepare("DELETE FROM bindings WHERE server_id=? AND target_kind='cli'").run(id);
      for (const cli of new Set(ids)) this.bind(id, "cli", cli);
    });
  }
```

`remove(id)` stays as it is: it deletes bindings but never `cli_entries`.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/unit/mcp-server-store-cli.test.js tests/unit/mcp-server-store.test.js tests/unit/mcp-server-oauth-record.test.js && wc -l server/features/mcp-servers/mcp-server-store.js`
Expected: PASS; the store has fewer than 600 lines.

- [ ] **Step 6: Check and commit**

Run: `npm run lint && npm run format:check && npm run check:structure`

```bash
git add server/features/mcp-servers/cli-entry-store.js server/features/mcp-servers/mcp-server-store.js tests/unit/mcp-server-store-cli.test.js
git commit -m "feat: record CLI bindings and AgentPier's native MCP entries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The reconciler

One focused module decides, per CLI, what each bound server's entry is and what to change, and applies it through `mcp-config.js`. An entry is AgentPier's while `cli_entries` records it and the file's entry hashes to the recorded `hash` or `pending_hash`. Everything else in the file is the owner's.

| File holds under the server's name     | Record                | Status                    | Action                           |
| -------------------------------------- | --------------------- | ------------------------- | -------------------------------- |
| nothing                                | any                   | `pending`                 | record, write, settle            |
| AgentPier's current entry              | same name             | `written`                 | settle if the record lags        |
| AgentPier's older entry (hash/pending) | same name             | `pending`                 | record, rewrite, settle          |
| something else                         | same name             | `conflict`                | none until the owner chooses     |
| something                              | none, or another name | `name-taken`              | none                             |
| a name in two OpenCode files           | any                   | `error`/`duplicate`       | none                             |
| (server unsupported by the CLI)        | any                   | `error`/`transport`·`cwd` | old entry removed if AgentPier's |

Records no longer wanted under their name (unbound, deleted, renamed, now unsupported) remove their file entry only while it is still AgentPier's; otherwise the record is dropped and the entry becomes a find. A file that cannot be read is never written: all bound servers of that CLI report `error`/`unreadable`. A lost compare-and-swap is retried with a fresh read, 3 attempts, then `error`/`changed`.

**Files:**

- Create: `server/features/mcp-servers/cli-reconciler.js`
- Modify: `server/lib/i18n/de/mcp-servers.js`, `server/lib/i18n/en/mcp-servers.js` (add `cliNotConflict`)
- Create: `tests/helpers/cli-mcp.js`
- Test: `tests/integration/cli-mcp-reconciler.test.js`, `tests/integration/cli-mcp-reconciler-recovery.test.js`

**Interfaces:**

- Consumes: `cliEntry`, `cliSupport`, `entryHash` (Task 3); `servers.cliEntries`, `servers.bindings("cli", cli)`, `servers.definitions()`, `servers.secrets(id)` (Task 4); `updateConfig(config, boundary, tool, key, name, entry)` and `CLI_CONFIG_CHANGED` (`mcp-config.js`); `ExtensionsStore.locations(id)` → `{ account, boundary, files, key }` and `ExtensionsStore.configs(locations)` → `Array<{ file, text, data }>` (`extension-store.js:40-151`).
- Produces: `class CliMcpReconciler({ servers, locate: (cli) => locations, configs: (locations) => configs, warn })` with
  - `read(cli) → { locations, configs, entries: Map<name, { entry, config, hash }>, duplicates: Set<name> }`
  - `desired(cli) → Map<serverId, { definition, entry?, hash?, reason? }>`
  - `plan(cli, snapshot) → { statuses: { [serverId]: { status, reason? } }, actions, finds: Array<{ name, entry, hash, duplicate }> }`
  - `inspect(cli)` (read-only) and `reconcile(cli)` → `{ cli, error?, statuses, actions, finds }`; never throw for a file problem
  - `apply(cli, actions)`, `write(cli, name, entry | undefined, expectedHash | undefined)`
  - `overwrite(serverId, cli)` (409 `cliNotConflict` unless the status is `conflict`)
  - Test helper `cliMcpFixture(t, { configs })` → `{ root, home, dataDir, accounts, sharedProfiles, extensions, servers, reconciler, warnings, file(cli), entries(cli), write(cli, entries, rest), raw(cli, text), text(cli) }`, plus `http(extra)` and `stdio(extra)` server inputs.

- [ ] **Step 1: Write the test fixture**

```js
// tests/helpers/cli-mcp.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { ExtensionsStore } from "../../server/features/extensions/extension-store.js";
import { SharedCliProfiles } from "../../server/features/cli-profiles/shared-profiles.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { CliMcpReconciler } from "../../server/features/mcp-servers/cli-reconciler.js";

const files = {
  claude: ".claude.json",
  codex: ".codex/config.toml",
  opencode: ".config/opencode/opencode.jsonc",
};
const keys = { claude: "mcpServers", codex: "mcp_servers", opencode: "mcp" };

/**
 * A temporary HOME and data directory with the real account, extension and server
 * stores and a reconciler over the canonical profiles `local-<cli>`. `configs(locations,
 * read)` may wrap the native read to play a concurrent writer. Never the owner's HOME.
 */
export function cliMcpFixture(t, { configs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-cli-mcp-"));
  const home = path.join(root, "home");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(home, { mode: 0o700 });
  const accounts = new AccountStore({ dataDir, home });
  const sharedProfiles = new SharedCliProfiles({ accounts });
  const extensions = new ExtensionsStore({ accounts, home, sharedProfiles });
  const servers = new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    // Fake commands exist unless their name says they are missing.
    exists: (file) => file.startsWith("/fake/") && !file.includes("missing"),
  });
  const warnings = [];
  const read = (locations) => extensions.configs(locations);
  const reconciler = new CliMcpReconciler({
    servers,
    locate: (cli) => extensions.locations(`local-${cli}`),
    configs: configs ? (locations) => configs(locations, read) : read,
    warn: (line) => warnings.push(line),
  });
  t.after(() => {
    try {
      servers.close();
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = (cli) => path.join(home, files[cli]);
  const raw = (cli, text) => {
    fs.mkdirSync(path.dirname(file(cli)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file(cli), text, { mode: 0o600 });
  };
  return {
    root,
    home,
    dataDir,
    accounts,
    sharedProfiles,
    extensions,
    servers,
    reconciler,
    warnings,
    file,
    raw,
    text: (cli) => fs.readFileSync(file(cli), "utf8"),
    /** The CLI's MCP entries as its file holds them now. */
    entries(cli) {
      if (!fs.existsSync(file(cli))) return {};
      const text = fs.readFileSync(file(cli), "utf8");
      return (cli === "codex" ? parseToml(text) : parseJsonc(text))[keys[cli]] ?? {};
    },
    /** Replaces the CLI's file: `entries` under its MCP key, plus `rest`. */
    write(cli, entries, rest = {}) {
      const data = { ...rest, [keys[cli]]: entries };
      raw(cli, cli === "codex" ? stringifyToml(data) : JSON.stringify(data, null, 2));
    },
  };
}

export const http = (extra = {}) => ({
  name: "docs",
  transport: "http",
  url: "https://mcp.example.test/mcp?key=query-secret",
  headers: { Authorization: "Bearer header-secret" },
  ...extra,
});
export const stdio = (extra = {}) => ({
  name: "local",
  transport: "stdio",
  command: "/fake/bin/server",
  args: ["--port", "1"],
  env: { TOKEN: "env-secret" },
  ...extra,
});
```

- [ ] **Step 2: Write the failing behaviour tests**

```js
// tests/integration/cli-mcp-reconciler.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  cliEntry,
  clis,
  entryHash,
} from "../../server/features/mcp-servers/cli-native.js";
import { cliMcpFixture, http, stdio } from "../helpers/cli-mcp.js";

const unrelated = {
  claude:
    '{\n  "theme": "keep-me",\n  "projects": { "/fixture": { "trusted": true } }\n}\n',
  codex:
    '# Keep this exact comment\nmodel = "fixture" # model comment\n[projects."/space path"]\ntrust_level = "trusted"\n',
  opencode: '{\n  // keep this comment\n  "theme": "keep-me",\n}\n',
};
const definition = (f, id) => f.servers.definitions().find((item) => item.id === id);

for (const cli of clis)
  test(`${cli}: a binding writes AgentPier's entry, keeps the rest and records only a hash`, (t) => {
    const f = cliMcpFixture(t);
    f.raw(cli, unrelated[cli]);
    const server = f.servers.create(http(), { bind: [["cli", cli]] });
    const result = f.reconciler.reconcile(cli);
    assert.deepEqual(result.statuses[server.id], { status: "written" });
    const expected = cliEntry(
      cli,
      definition(f, server.id),
      f.servers.secrets(server.id),
    );
    assert.deepEqual(f.entries(cli).docs, expected);
    if (cli === "codex") assert.ok(f.text(cli).startsWith(unrelated.codex));
    else
      assert.match(
        f.text(cli),
        cli === "claude" ? /"theme": "keep-me"/ : /\/\/ keep this comment/,
      );
    assert.equal(fs.statSync(f.file(cli)).mode & 0o777, 0o600);
    const row = f.servers.cliEntries.get(server.id, cli);
    assert.deepEqual(
      [row.name, row.hash, row.pendingHash],
      ["docs", entryHash(expected), null],
    );
    assert.doesNotMatch(JSON.stringify([row, result.statuses, f.warnings]), /secret/);
    assert.deepEqual(result.finds, []);
  });

test("unbinding or deleting removes only AgentPier's entry and its record", (t) => {
  const f = cliMcpFixture(t);
  f.write("claude", { mine: { type: "stdio", command: "/bin/owner" } });
  const a = f.servers.create(http(), { bind: [["cli", "claude"]] });
  const b = f.servers.create(http({ name: "other" }), { bind: [["cli", "claude"]] });
  f.reconciler.reconcile("claude");
  assert.deepEqual(Object.keys(f.entries("claude")).sort(), ["docs", "mine", "other"]);
  f.servers.setClis(a.id, []);
  f.servers.remove(b.id);
  const result = f.reconciler.reconcile("claude");
  assert.deepEqual(f.entries("claude"), {
    mine: { type: "stdio", command: "/bin/owner" },
  });
  assert.deepEqual(f.servers.cliEntries.list("claude"), []);
  assert.deepEqual(
    result.finds.map((find) => find.name),
    ["mine"],
  );
});

test("a hand-edited entry is a conflict until the owner chooses, and a find once unbound", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "codex"]] });
  f.reconciler.reconcile("codex");
  const edited = { ...f.entries("codex").docs, url: "https://edited.example.test/mcp" };
  f.write("codex", { docs: edited });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "conflict",
  });
  assert.deepEqual(f.entries("codex").docs, edited);
  f.reconciler.overwrite(server.id, "codex");
  assert.equal(
    f.entries("codex").docs.url,
    "https://mcp.example.test/mcp?key=query-secret",
  );
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
  f.write("codex", { docs: edited });
  f.servers.setClis(server.id, []);
  const result = f.reconciler.reconcile("codex");
  assert.deepEqual(f.entries("codex").docs, edited);
  assert.deepEqual(
    result.finds.map((find) => find.name),
    ["docs"],
  );
  assert.throws(() => f.reconciler.overwrite(server.id, "codex"), { status: 409 });
});

test("a name taken by the owner's entry is neither written nor listed as a find", (t) => {
  const f = cliMcpFixture(t);
  const owner = { type: "remote", url: "https://owner.example.test/mcp", enabled: true };
  f.write("opencode", { docs: owner });
  const server = f.servers.create(http(), { bind: [["cli", "opencode"]] });
  const result = f.reconciler.reconcile("opencode");
  assert.deepEqual(result.statuses[server.id], { status: "name-taken" });
  assert.deepEqual(f.entries("opencode"), { docs: owner });
  assert.deepEqual(result.finds, []);
  assert.equal(f.servers.cliEntries.get(server.id, "opencode"), null);
});

test("a configuration that cannot be read is never written; the other CLIs continue", (t) => {
  const f = cliMcpFixture(t);
  const broken = {
    claude: '{/* Claude accepts no comments */"theme":"keep"}',
    codex: "invalid = [",
    opencode: '{"mcp":{"old":{"type":"local","command":["keep"]}},"mcp":{}}',
  };
  const server = f.servers.create(http(), { bind: clis.map((cli) => ["cli", cli]) });
  for (const [cli, text] of Object.entries(broken)) {
    for (const other of clis) fs.rmSync(f.file(other), { force: true });
    f.raw(cli, text);
    const result = f.reconciler.reconcile(cli);
    assert.equal(result.error, "unreadable");
    assert.deepEqual(result.statuses[server.id], {
      status: "error",
      reason: "unreadable",
    });
    assert.equal(f.text(cli), text);
    const fine = clis.find((other) => other !== cli);
    assert.deepEqual(f.reconciler.reconcile(fine).statuses[server.id], {
      status: "written",
    });
  }
  assert.ok(f.warnings.length > 0);
  assert.ok(f.warnings.every((line) => !line.includes(f.home) && !/secret/.test(line)));
});

test("a symlinked configuration file is refused and its target untouched", (t) => {
  const f = cliMcpFixture(t);
  const outside = path.join(f.root, "outside.json");
  fs.writeFileSync(outside, "{}");
  fs.symlinkSync(outside, f.file("claude"));
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "error",
    reason: "unreadable",
  });
  assert.equal(fs.readFileSync(outside, "utf8"), "{}");
});

test("an OpenCode name defined in two files is left alone", (t) => {
  const f = cliMcpFixture(t);
  const dir = path.join(f.home, ".config/opencode");
  fs.mkdirSync(dir, { recursive: true });
  const one = JSON.stringify({ mcp: { docs: { type: "local", command: ["old"] } } });
  const two = JSON.stringify({ mcp: { docs: { type: "local", command: ["new"] } } });
  fs.writeFileSync(path.join(dir, "opencode.json"), one);
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), two);
  const server = f.servers.create(http(), { bind: [["cli", "opencode"]] });
  const result = f.reconciler.reconcile("opencode");
  assert.deepEqual(result.statuses[server.id], { status: "error", reason: "duplicate" });
  assert.equal(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"), one);
  assert.equal(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8"), two);
});

test("inspect reports without writing anything", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(stdio(), { bind: [["cli", "claude"]] });
  assert.deepEqual(f.reconciler.inspect("claude").statuses[server.id], {
    status: "pending",
  });
  assert.equal(fs.existsSync(f.file("claude")), false);
  assert.deepEqual(f.servers.cliEntries.list("claude"), []);
});

test("a server the CLI cannot run is reported and its old entry removed", (t) => {
  const f = cliMcpFixture(t);
  const sse = f.servers.create(http({ name: "events", transport: "sse" }), {
    bind: [["cli", "codex"]],
  });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[sse.id], {
    status: "error",
    reason: "transport",
  });
  assert.deepEqual(f.entries("codex"), {});
  const local = f.servers.create(stdio(), { bind: [["cli", "claude"]] });
  f.reconciler.reconcile("claude");
  assert.ok(f.entries("claude").local);
  f.servers.update(local.id, { revision: 1, cwd: "/tmp" });
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[local.id], {
    status: "error",
    reason: "cwd",
  });
  assert.equal(f.entries("claude").local, undefined);
});
```

```js
// tests/integration/cli-mcp-reconciler-recovery.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { entryHash } from "../../server/features/mcp-servers/cli-native.js";
import { cliMcpFixture, http } from "../helpers/cli-mcp.js";

/** Plays Claude Code rewriting ~/.claude.json with a changed counter. */
const touch = (f, value) => {
  const data = fs.existsSync(f.file("claude")) ? JSON.parse(f.text("claude")) : {};
  fs.writeFileSync(
    f.file("claude"),
    JSON.stringify({ ...data, numStartups: value }, null, 2),
  );
};

test("a file changed between read and write is read again and written", (t) => {
  let calls = 0;
  let f = null;
  f = cliMcpFixture(t, {
    configs: (locations, read) => {
      const result = read(locations);
      if (++calls === 2) touch(f, 7);
      return result;
    },
  });
  f.write("claude", {});
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "written",
  });
  assert.equal(JSON.parse(f.text("claude")).numStartups, 7);
  assert.ok(f.entries("claude").docs);
  assert.ok(calls >= 4);
});

test("a file that keeps changing is given up after three attempts, untouched", (t) => {
  let calls = 0;
  let f = null;
  f = cliMcpFixture(t, {
    configs: (locations, read) => {
      const result = read(locations);
      touch(f, ++calls);
      return result;
    },
  });
  f.write("claude", {});
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  const result = f.reconciler.reconcile("claude");
  assert.equal(result.error, "changed");
  assert.deepEqual(result.statuses[server.id], { status: "error", reason: "changed" });
  assert.equal(f.entries("claude").docs, undefined);
  assert.equal(JSON.parse(f.text("claude")).numStartups, calls);
});

test("a write recorded but not yet in the file is finished by the next run", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "codex"]] });
  const want = f.reconciler.desired("codex").get(server.id);
  f.servers.cliEntries.intend(server.id, "codex", "docs", want.hash);
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
  assert.equal(entryHash(f.entries("codex").docs), want.hash);
  assert.equal(f.servers.cliEntries.get(server.id, "codex").pendingHash, null);
});

test("a write in the file but not yet settled is recognised as AgentPier's", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "codex"]] });
  const want = f.reconciler.desired("codex").get(server.id);
  f.servers.cliEntries.intend(server.id, "codex", "docs", want.hash);
  f.write("codex", { docs: want.entry });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
  const row = f.servers.cliEntries.get(server.id, "codex");
  assert.deepEqual([row.hash, row.pendingHash], [want.hash, null]);
});

test("a deleted server's entry waits for a readable file, then goes", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  f.reconciler.reconcile("claude");
  const good = f.text("claude");
  f.raw("claude", "{ broken");
  f.servers.remove(server.id);
  assert.equal(f.reconciler.reconcile("claude").error, "unreadable");
  assert.equal(f.servers.cliEntries.list("claude").length, 1);
  f.raw("claude", good);
  f.reconciler.reconcile("claude");
  assert.deepEqual(f.entries("claude"), {});
  assert.deepEqual(f.servers.cliEntries.list("claude"), []);
});

// Review Focus 1
test("a file the CLI re-serialized keeps AgentPier's entries managed", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), {
    bind: [
      ["cli", "claude"],
      ["cli", "codex"],
    ],
  });
  f.reconciler.reconcile("claude");
  f.reconciler.reconcile("codex");
  const docs = f.entries("claude").docs;
  const reordered = Object.fromEntries(Object.entries(docs).reverse());
  fs.writeFileSync(
    f.file("claude"),
    JSON.stringify({ numStartups: 3, mcpServers: { docs: reordered } }),
  );
  const codex = f.entries("codex").docs;
  fs.writeFileSync(
    f.file("codex"),
    `[mcp_servers.docs]\nhttp_headers = { Authorization = ${JSON.stringify(codex.http_headers.Authorization)} }\nurl = ${JSON.stringify(codex.url)}\n`,
  );
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "written",
  });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
});

// Review Focus 2
test("renaming a bound server replaces its entry and leaves no find", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "opencode"]] });
  f.reconciler.reconcile("opencode");
  f.servers.update(server.id, { revision: 1, name: "docs2" });
  const result = f.reconciler.reconcile("opencode");
  assert.deepEqual(Object.keys(f.entries("opencode")), ["docs2"]);
  assert.deepEqual(result.statuses[server.id], { status: "written" });
  assert.deepEqual(result.finds, []);
  assert.equal(f.servers.cliEntries.get(server.id, "opencode").name, "docs2");
});

// Review Focus 3
test("a new header value rewrites AgentPier's entry and is no conflict", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  f.reconciler.reconcile("claude");
  f.servers.update(server.id, {
    revision: 1,
    headers: { Authorization: "Bearer rotated-secret" },
  });
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "written",
  });
  assert.equal(f.entries("claude").docs.headers.Authorization, "Bearer rotated-secret");
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/integration/cli-mcp-reconciler.test.js tests/integration/cli-mcp-reconciler-recovery.test.js`
Expected: FAIL with `Cannot find module '…/cli-reconciler.js'`.

- [ ] **Step 4: Add the conflict message**

In `server/lib/i18n/de/mcp-servers.js` add inside `mcpServers`:

```js
  cliNotConflict:
    "Dieser Eintrag in der CLI steht nicht mehr im Konflikt. Bitte neu laden.",
```

and in `server/lib/i18n/en/mcp-servers.js`:

```js
  cliNotConflict: "This entry in the CLI is no longer in conflict. Please reload.",
```

- [ ] **Step 5: Write the reconciler**

```js
// server/features/mcp-servers/cli-reconciler.js
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { CLI_CONFIG_CHANGED, updateConfig } from "../extensions/mcp-config.js";
import { cliEntry, cliSupport, entryHash } from "./cli-native.js";

const messages = serverMessages.mcpServers;
// Passes per reconciliation: a lost compare-and-swap is read again and retried.
const attempts = 3;
const changed = () =>
  Object.assign(problem(serverMessages.extensions.cliConfigChanged, 409), {
    code: CLI_CONFIG_CHANGED,
  });

/**
 * Keeps each CLI's native MCP entries in step with the central CLI bindings. An entry
 * is AgentPier's while `cli_entries` records it and the file's entry hashes to the
 * recorded or the pending hash; everything else in the file is the owner's and is
 * never modified. Every change is recorded before the file is written, so the next
 * run finishes a change a crash interrupted.
 */
export class CliMcpReconciler {
  constructor({ servers, locate, configs, warn = console.warn }) {
    Object.assign(this, { servers, locate, configs, warn });
    this.entries = servers.cliEntries;
  }

  /** The CLI's native MCP entries by name, across all of its files. */
  read(cli) {
    const locations = this.locate(cli);
    const configs = this.configs(locations);
    const entries = new Map();
    const duplicates = new Set();
    for (const config of configs)
      for (const [name, entry] of Object.entries(config.data[locations.key] || {})) {
        if (entries.has(name)) duplicates.add(name);
        entries.set(name, { entry, config, hash: entryHash(entry) });
      }
    return { locations, configs, entries, duplicates };
  }

  /** What the bindings want in `cli`: serverId → `{ definition, entry, hash }` or `{ definition, reason }`. */
  desired(cli) {
    const bound = new Set(this.servers.bindings("cli", cli));
    const out = new Map();
    for (const definition of this.servers.definitions()) {
      if (!bound.has(definition.id)) continue;
      const support = cliSupport(cli, definition);
      if (!support.supported)
        out.set(definition.id, { definition, reason: support.reason });
      else if (definition.args === null)
        out.set(definition.id, { definition, reason: "invalid" });
      else {
        const entry = cliEntry(cli, definition, this.servers.secrets(definition.id));
        out.set(definition.id, { definition, entry, hash: entryHash(entry) });
      }
    }
    return out;
  }

  /** Every status, change and find for one snapshot of the file; writes nothing. */
  plan(cli, snapshot) {
    const desired = this.desired(cli);
    const rows = this.entries.list(cli);
    const rowOf = new Map(rows.map((row) => [row.serverId, row]));
    const owned = (row, found) =>
      !!found && (found.hash === row.hash || found.hash === row.pendingHash);
    const statuses = {};
    const actions = [];
    const claimed = new Set();
    // Names AgentPier no longer wants: unbound, deleted, renamed or now unsupported.
    for (const row of rows) {
      const want = desired.get(row.serverId);
      if (want?.entry && want.definition.name === row.name) continue;
      const found = snapshot.entries.get(row.name);
      if (owned(row, found) && !snapshot.duplicates.has(row.name)) {
        claimed.add(row.name);
        actions.push({
          type: "remove",
          serverId: row.serverId,
          name: row.name,
          expected: found.hash,
          keep: !!want?.entry,
        });
      } else if (!want?.entry) actions.push({ type: "forget", serverId: row.serverId });
    }
    for (const [serverId, want] of desired) {
      const name = want.definition.name;
      const row = rowOf.get(serverId);
      const mine = row?.name === name ? row : null;
      const found = snapshot.entries.get(name);
      if (found && want.entry) claimed.add(name);
      if (!want.entry) statuses[serverId] = { status: "error", reason: want.reason };
      else if (snapshot.duplicates.has(name))
        statuses[serverId] = { status: "error", reason: "duplicate" };
      else if (!found) {
        statuses[serverId] = { status: "pending" };
        actions.push({
          type: "write",
          serverId,
          name,
          entry: want.entry,
          hash: want.hash,
        });
      } else if (!mine) statuses[serverId] = { status: "name-taken" };
      else if (found.hash === want.hash) {
        statuses[serverId] = { status: "written" };
        if (mine.hash !== want.hash || mine.pendingHash)
          actions.push({ type: "settle", serverId, hash: want.hash });
      } else if (owned(mine, found)) {
        statuses[serverId] = { status: "pending" };
        actions.push({
          type: "write",
          serverId,
          name,
          entry: want.entry,
          hash: want.hash,
          expected: found.hash,
        });
      } else statuses[serverId] = { status: "conflict" };
    }
    const finds = [...snapshot.entries]
      .filter(([name]) => !claimed.has(name))
      .map(([name, found]) => ({
        name,
        entry: found.entry,
        hash: found.hash,
        duplicate: snapshot.duplicates.has(name),
      }));
    return { statuses, actions, finds };
  }

  /** The current state of `cli` without changing anything. */
  inspect(cli) {
    return this.guard(cli, () => ({ cli, ...this.plan(cli, this.read(cli)) }), false);
  }

  /** Brings `cli` in step with the bindings and reports the result. */
  reconcile(cli) {
    return this.guard(cli, () => {
      for (let attempt = 1; ; attempt++) {
        const result = this.plan(cli, this.read(cli));
        if (!result.actions.length || attempt > attempts) return { cli, ...result };
        try {
          this.apply(cli, result.actions);
        } catch (error) {
          if (error?.code !== CLI_CONFIG_CHANGED || attempt === attempts) throw error;
        }
      }
    });
  }

  /** Store first, then file: a crash in between is finished by the next run. */
  apply(cli, actions) {
    for (const action of actions) {
      if (action.type === "forget") this.entries.forget(action.serverId, cli);
      else if (action.type === "settle")
        this.entries.settle(action.serverId, cli, action.hash);
      else if (action.type === "remove") {
        this.write(cli, action.name, undefined, action.expected);
        if (!action.keep) this.entries.forget(action.serverId, cli);
      } else {
        this.entries.intend(action.serverId, cli, action.name, action.hash);
        this.write(cli, action.name, action.entry, action.expected);
        this.entries.settle(action.serverId, cli, action.hash);
      }
    }
  }

  /** Writes (or with `entry` undefined removes) `name`, if the file still holds `expected`. */
  write(cli, name, entry, expected) {
    const snapshot = this.read(cli);
    if (snapshot.duplicates.has(name) || snapshot.entries.get(name)?.hash !== expected)
      throw changed();
    const target = snapshot.entries.get(name)?.config ?? snapshot.configs.at(-1);
    updateConfig(
      target,
      snapshot.locations.boundary,
      cli,
      snapshot.locations.key,
      name,
      entry,
    );
  }

  /** Writes AgentPier's version over the owner's edit of server `serverId`'s entry. */
  overwrite(serverId, cli) {
    const snapshot = this.read(cli);
    if (this.plan(cli, snapshot).statuses[serverId]?.status !== "conflict")
      throw problem(messages.cliNotConflict, 409);
    const want = this.desired(cli).get(serverId);
    const found = snapshot.entries.get(want.definition.name);
    this.apply(cli, [
      {
        type: "write",
        serverId,
        name: want.definition.name,
        entry: want.entry,
        hash: want.hash,
        expected: found.hash,
      },
    ]);
  }

  /**
   * A file that cannot be read or kept changing: every bound server of `cli` reports
   * why, with a stable reason only (never a path or a value).
   */
  guard(cli, work, loud = true) {
    try {
      return work();
    } catch (error) {
      const reason = error?.code === CLI_CONFIG_CHANGED ? "changed" : "unreadable";
      if (loud) this.warn(`MCP servers for ${cli} could not be written (${reason}).`);
      const statuses = {};
      for (const serverId of this.servers.bindings("cli", cli))
        statuses[serverId] = { status: "error", reason };
      return { cli, error: reason, statuses, actions: [], finds: [] };
    }
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `node --test tests/integration/cli-mcp-reconciler.test.js tests/integration/cli-mcp-reconciler-recovery.test.js tests/unit/server-i18n-catalogs.test.js`
Expected: PASS.

- [ ] **Step 7: Check and commit**

Run: `npm run lint && npm run format:check && npm run check:structure`

```bash
git add server/features/mcp-servers/cli-reconciler.js server/lib/i18n/de/mcp-servers.js server/lib/i18n/en/mcp-servers.js tests/helpers/cli-mcp.js tests/integration/cli-mcp-reconciler.test.js tests/integration/cli-mcp-reconciler-recovery.test.js
git commit -m "feat: reconcile central MCP bindings with the CLIs' native entries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Finds, adoption and adopting a hand edit

Turns the reconciler's finds into groups the owner can adopt (merging identical entries across CLIs, proposing valid names), creates servers from them, and replaces the native entries with AgentPier's, only while they are unchanged since the owner saw them. Also builds the central update for "Adopt the change" on a conflict or a taken name. **Rulings (spec silent):** adopting a find needs no stdio confirmation (the command already runs in that CLI and is bound only there); the "Adopt" offered for a taken name takes the owner's entry over into the existing server, like "Adopt the change"; a remote entry without headers adopted into an OAuth server keeps OAuth (Claude Code and Codex write both the same way).

**Files:**

- Create: `server/features/mcp-servers/cli-finds.js`
- Create: `server/features/mcp-servers/cli-adoption.js`
- Modify: `server/features/mcp-servers/cli-reconciler.js` (add `adopt`, `contested`, `claim`)
- Modify: `server/lib/i18n/de/mcp-servers.js`, `server/lib/i18n/en/mcp-servers.js` (add `cliFindChanged`, `cliNotAdoptable`, `cliChangeNotAdoptable`)
- Test: `tests/integration/cli-mcp-adoption.test.js`

**Interfaces:**

- Consumes: `CliMcpReconciler` (Task 5), `centralFromNative`, `contentKey`, `proposeName`, `clis` (Task 3), `servers.create(input, { bind })` (Task 4), `publicUrl` (`mcp-server-store.js:41`), `namePattern` (`command-resolution.js:7`), `messageIdentity` (`server/lib/i18n/message-identity.js`).
- Produces:
  - `groupFinds(results: { [cli]: { finds } }, centralNames: string[]) → Group[]`, `Group = { key, name, parsed, members: Array<{ cli, name, hash }>, proposedName? }`.
  - `publicFind(group) → { key, name, clis, adoptable, reason? , proposedName?, transport?, auth?, url?, command?, headerNames?, envNames? }`.
  - `adoptInput(name, parsed)`, `adoptFinds({ servers, reconciler, groups, keys, names, all }) → { adopted: Array<server & { clis }>, failed: Array<{ key, name, error, messageKey? }> }`, `patchFromNative(server, cli, parsed) → update input`.
  - `reconciler.adopt(cli, serverId, { name, hash })`, `reconciler.contested(serverId, cli) → { entry, config, hash }`, `reconciler.claim(serverId, cli, hash)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/integration/cli-mcp-adoption.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  adoptFinds,
  patchFromNative,
} from "../../server/features/mcp-servers/cli-adoption.js";
import { groupFinds, publicFind } from "../../server/features/mcp-servers/cli-finds.js";
import { centralFromNative, clis } from "../../server/features/mcp-servers/cli-native.js";
import { cliMcpFixture, http } from "../helpers/cli-mcp.js";

const groups = (f) =>
  groupFinds(
    Object.fromEntries(clis.map((cli) => [cli, f.reconciler.inspect(cli)])),
    f.servers.list().map((server) => server.name),
  );
const adopt = (f, options) =>
  adoptFinds({
    servers: f.servers,
    reconciler: f.reconciler,
    groups: groups(f),
    ...options,
  });
const remote = (url) => ({
  claude: { type: "http", url, headers: { Authorization: "Bearer find-secret" } },
  codex: { url, http_headers: { Authorization: "Bearer find-secret" } },
});

test("identical finds merge across CLIs; other content and invalid or taken names get proposals", (t) => {
  const f = cliMcpFixture(t);
  f.servers.create(http({ name: "taken" }));
  const same = remote("https://same.example.test/mcp");
  f.write("claude", {
    docs: same.claude,
    "my.server": { type: "stdio", command: "/fake/bin/tool" },
    taken: same.claude,
  });
  f.write("codex", { docs: same.codex });
  f.write("opencode", {
    docs: { type: "remote", url: "https://other.example.test/mcp", enabled: true },
  });
  const found = groups(f).map(publicFind);
  assert.deepEqual(
    found.map((group) => [group.name, group.clis, group.proposedName ?? null]),
    [
      ["docs", ["claude", "codex"], null],
      ["my.server", ["claude"], "my-server"],
      ["taken", ["claude"], "taken-2"],
      ["docs", ["opencode"], "docs-2"],
    ],
  );
  assert.deepEqual(found[0].headerNames, ["Authorization"]);
  assert.doesNotMatch(JSON.stringify(found), /find-secret/);
});

test("adopting a merged find binds one server to each CLI and makes the entries AgentPier's", (t) => {
  const f = cliMcpFixture(t);
  const same = remote("https://same.example.test/mcp");
  f.write("claude", { docs: same.claude });
  f.write("codex", { docs: same.codex });
  const { adopted, failed } = adopt(f, { keys: [groups(f)[0].key] });
  assert.deepEqual(failed, []);
  assert.deepEqual(
    adopted.map((server) => [server.name, server.clis]),
    [["docs", ["claude", "codex"]]],
  );
  assert.deepEqual(f.servers.secrets(adopted[0].id).headers, {
    Authorization: "Bearer find-secret",
  });
  for (const cli of ["claude", "codex"]) {
    const result = f.reconciler.reconcile(cli);
    assert.deepEqual(result.statuses[adopted[0].id], { status: "written" });
    assert.deepEqual(result.finds, []);
  }
  assert.deepEqual(f.entries("claude").docs, same.claude);
});

test("adopting under a new name replaces the old entry, only if it is unchanged", (t) => {
  const f = cliMcpFixture(t);
  const entry = { type: "stdio", command: "/fake/bin/tool", args: [], env: {} };
  f.write("claude", { "my.server": entry });
  const stale = groups(f);
  f.write("claude", { "my.server": { ...entry, args: ["changed"] } });
  assert.throws(
    () =>
      adoptFinds({
        servers: f.servers,
        reconciler: f.reconciler,
        groups: groups(f),
        keys: [stale[0].key],
      }),
    { status: 409 },
  );
  assert.deepEqual(f.servers.list(), []);
  const [fresh] = groups(f);
  const { adopted } = adopt(f, { keys: [fresh.key], names: { [fresh.key]: "tool" } });
  assert.equal(adopted[0].name, "tool");
  assert.deepEqual(Object.keys(f.entries("claude")), ["tool"]);
  assert.deepEqual(f.entries("claude").tool.args, ["changed"]);
});

// Review Focus 5
test("adopt all reports an entry whose command is not on PATH and adopts the rest", (t) => {
  const f = cliMcpFixture(t);
  const missing = { command: "missing-tool", args: ["-y", "some-server"] };
  f.write("codex", {
    docs: remote("https://same.example.test/mcp").codex,
    tool: missing,
  });
  const { adopted, failed } = adopt(f, { all: true });
  assert.deepEqual(
    adopted.map((server) => server.name),
    ["docs"],
  );
  assert.deepEqual(
    failed.map((item) => [item.name, item.messageKey]),
    [["tool", "mcpServers.commandNotFound"]],
  );
  assert.deepEqual(f.entries("codex").tool, missing);
  assert.deepEqual(
    f.servers.list().map((server) => server.name),
    ["docs"],
  );
});

test("an entry with settings AgentPier does not manage cannot be adopted", (t) => {
  const f = cliMcpFixture(t);
  f.write("codex", {
    slow: { url: "https://x.example.test/mcp", startup_timeout_sec: 30 },
  });
  const [find] = groups(f).map(publicFind);
  assert.deepEqual([find.adoptable, find.reason], [false, "unsupported-fields"]);
  assert.throws(() => adopt(f, { keys: [find.key] }), { status: 409 });
  assert.throws(() => adopt(f, { keys: [] }), { status: 400 });
});

test("adopting a hand edit moves it into the central server for every CLI", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), {
    bind: [
      ["cli", "claude"],
      ["cli", "codex"],
    ],
  });
  f.reconciler.reconcile("claude");
  f.reconciler.reconcile("codex");
  f.write("claude", {
    docs: {
      type: "http",
      url: "https://edited.example.test/mcp",
      headers: { "X-Key": "new-secret" },
    },
  });
  const found = f.reconciler.contested(server.id, "claude");
  const patch = patchFromNative(
    f.servers.get(server.id),
    "claude",
    centralFromNative("claude", found.entry),
  );
  assert.deepEqual(patch, {
    revision: 1,
    url: "https://edited.example.test/mcp",
    auth: "headers",
    headers: { Authorization: null, "X-Key": "new-secret" },
  });
  f.servers.update(server.id, patch);
  f.reconciler.claim(server.id, "claude", found.hash);
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "written",
  });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
  assert.equal(f.entries("codex").docs.url, "https://edited.example.test/mcp");
  assert.deepEqual(f.servers.get(server.id).headerNames, ["X-Key"]);
  assert.throws(() => f.reconciler.contested(server.id, "claude"), { status: 409 });
});

test("a taken name can be adopted into the server; an OAuth server stays OAuth", (t) => {
  const f = cliMcpFixture(t);
  f.write("claude", { docs: { type: "http", url: "https://owner.example.test/mcp" } });
  const server = f.servers.create(
    {
      name: "docs",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      auth: "oauth",
    },
    { bind: [["cli", "claude"]] },
  );
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "name-taken",
  });
  const found = f.reconciler.contested(server.id, "claude");
  const patch = patchFromNative(
    f.servers.get(server.id),
    "claude",
    centralFromNative("claude", found.entry),
  );
  assert.deepEqual(patch, {
    revision: 1,
    url: "https://owner.example.test/mcp",
    auth: "oauth",
    oauthScope: "",
  });
  f.servers.update(server.id, patch);
  f.reconciler.claim(server.id, "claude", found.hash);
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "written",
  });
  assert.equal(f.servers.get(server.id).auth, "oauth");
  assert.throws(
    () =>
      patchFromNative(
        f.servers.get(server.id),
        "claude",
        centralFromNative("claude", { type: "stdio", command: "/fake/bin/x" }),
      ),
    { status: 409 },
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/integration/cli-mcp-adoption.test.js`
Expected: FAIL with `Cannot find module '…/cli-adoption.js'`.

- [ ] **Step 3: Add the messages**

`server/lib/i18n/de/mcp-servers.js`:

```js
  cliFindChanged:
    "Der Eintrag in der CLI hat sich seit der Anzeige geändert. Bitte neu laden.",
  cliNotAdoptable:
    "AgentPier kann diesen Eintrag nicht übernehmen, ohne Einstellungen zu verlieren, die es nicht verwaltet.",
  cliChangeNotAdoptable:
    "Die Änderung lässt sich nicht übernehmen: Die Verbindungsart weicht ab oder der Eintrag nutzt Einstellungen, die AgentPier nicht verwaltet.",
```

`server/lib/i18n/en/mcp-servers.js`:

```js
  cliFindChanged: "The entry in the CLI changed since it was shown. Please reload.",
  cliNotAdoptable:
    "AgentPier cannot take over this entry without losing settings it does not manage.",
  cliChangeNotAdoptable:
    "The change cannot be adopted: its connection type differs or it uses settings AgentPier does not manage.",
```

- [ ] **Step 4: Write the finds**

```js
// server/features/mcp-servers/cli-finds.js
import { createHash } from "node:crypto";
import { namePattern } from "./command-resolution.js";
import { centralFromNative, clis, contentKey, proposeName } from "./cli-native.js";
import { publicUrl } from "./mcp-server-store.js";

/**
 * The owner's own entries in all CLIs (`results`: cli → reconciler result) as groups
 * to adopt. The same name with the same content in several CLIs is one group, which
 * becomes one server bound to each of them; anything else stays separate. A name that
 * is invalid or already used centrally gets a proposal, assigned in CLI order. Groups
 * hold values and never leave the server; `publicFind` is what responses show.
 */
export function groupFinds(results, centralNames) {
  const groups = new Map();
  for (const cli of clis)
    for (const find of results[cli]?.finds || []) {
      const parsed = find.duplicate
        ? { ok: false, reason: "duplicate" }
        : centralFromNative(cli, find.entry);
      const id = parsed.ok
        ? `${find.name}\0${contentKey(parsed)}`
        : `${cli}\0${find.name}`;
      if (!groups.has(id)) groups.set(id, { name: find.name, parsed, members: [] });
      groups.get(id).members.push({ cli, name: find.name, hash: find.hash });
    }
  const taken = new Set(centralNames.map((name) => name.toLowerCase()));
  return [...groups.values()].map((group) => {
    // The key changes with any member's content: a stale page cannot adopt an edit.
    const key = createHash("sha256")
      .update(JSON.stringify(group.members))
      .digest("hex")
      .slice(0, 32);
    if (!group.parsed.ok) return { key, ...group };
    const free = namePattern.test(group.name) && !taken.has(group.name.toLowerCase());
    const name = free ? group.name : proposeName(group.name, taken);
    taken.add(name.toLowerCase());
    return { key, ...group, ...(free ? {} : { proposedName: name }) };
  });
}

/** A find as responses show it: header and environment names, never a value. */
export function publicFind(group) {
  const base = {
    key: group.key,
    name: group.name,
    clis: group.members.map((member) => member.cli),
    adoptable: group.parsed.ok,
  };
  if (!group.parsed.ok) return { ...base, reason: group.parsed.reason };
  const { definition, secrets } = group.parsed;
  return {
    ...base,
    ...(group.proposedName ? { proposedName: group.proposedName } : {}),
    transport: definition.transport,
    auth: definition.auth,
    ...(definition.url ? { url: publicUrl(definition.url) } : {}),
    ...(definition.command ? { command: definition.command } : {}),
    headerNames: Object.keys(secrets.headers).sort(),
    envNames: Object.keys(secrets.env).sort(),
  };
}
```

- [ ] **Step 5: Write the adoption**

```js
// server/features/mcp-servers/cli-adoption.js
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { problem } from "../../lib/storage.js";

const messages = serverMessages.mcpServers;
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** The store input that creates a server named `name` from a parsed native entry. */
export function adoptInput(name, { definition, secrets }) {
  if (definition.transport === "stdio")
    return {
      name,
      transport: "stdio",
      command: definition.command,
      args: definition.args,
      ...(definition.cwd ? { cwd: definition.cwd } : {}),
      env: secrets.env,
    };
  return {
    name,
    transport: definition.transport,
    url: definition.url,
    ...(definition.auth === "oauth"
      ? {
          auth: "oauth",
          ...(definition.oauthScope ? { oauthScope: definition.oauthScope } : {}),
        }
      : { headers: secrets.headers }),
  };
}

/**
 * Adopts finds: each chosen group becomes a server bound to the CLIs it was found in,
 * and its native entries become AgentPier's. `keys` picks groups (an unknown key means
 * the CLIs changed since the owner looked: 409); `all` takes every adoptable group and
 * reports a failing one by name instead of stopping. `names[key]` renames a group.
 */
export function adoptFinds({
  servers,
  reconciler,
  groups,
  keys = [],
  names = {},
  all = false,
}) {
  if (!record(names) || (!all && (!Array.isArray(keys) || !keys.length)))
    throw problem(messages.invalidRequest, 400);
  const chosen = all
    ? groups.filter((group) => group.parsed.ok)
    : keys.map((key) => {
        const group = groups.find((item) => item.key === key);
        if (!group) throw problem(messages.cliFindChanged, 409);
        if (!group.parsed.ok) throw problem(messages.cliNotAdoptable, 409);
        return group;
      });
  const adopted = [];
  const failed = [];
  for (const group of chosen) {
    const name =
      typeof names[group.key] === "string"
        ? names[group.key].trim()
        : (group.proposedName ?? group.name);
    try {
      const server = servers.create(adoptInput(name, group.parsed), {
        bind: group.members.map((member) => ["cli", member.cli]),
      });
      for (const member of group.members) reconciler.adopt(member.cli, server.id, member);
      adopted.push({ ...server, clis: group.members.map((member) => member.cli) });
    } catch (error) {
      if (!all) throw error;
      // Stable messages only: an unexpected error can carry a path.
      const message =
        Number.isInteger(error?.status) && error.status < 500
          ? error.message
          : messages.cliNotAdoptable;
      failed.push({
        key: group.key,
        name: group.name,
        error: message,
        ...messageIdentity(message),
      });
    }
  }
  return { adopted, failed };
}

/**
 * The update that makes `server` (public) match the owner's edit `parsed`, found in
 * `cli`. OpenCode's `remote` cannot tell SSE from HTTP, and Claude Code and Codex
 * write an OAuth server like a header server without headers: both keep the server's
 * own kind.
 */
export function patchFromNative(server, cli, parsed) {
  const { definition, secrets } = parsed;
  const transport =
    cli === "opencode" && server.transport === "sse" && definition.transport === "http"
      ? "sse"
      : definition.transport;
  if (transport !== server.transport) throw problem(messages.cliChangeNotAdoptable, 409);
  const replace = (names, values) => ({
    ...Object.fromEntries(
      names.filter((name) => !Object.hasOwn(values, name)).map((name) => [name, null]),
    ),
    ...values,
  });
  if (transport === "stdio")
    return {
      revision: server.revision,
      command: definition.command,
      args: definition.args,
      cwd: definition.cwd ?? "",
      env: replace(server.envNames, secrets.env),
    };
  const auth =
    definition.auth === "headers" &&
    !Object.keys(secrets.headers).length &&
    server.auth === "oauth"
      ? "oauth"
      : definition.auth;
  return {
    revision: server.revision,
    url: definition.url,
    auth,
    ...(auth === "oauth"
      ? { oauthScope: definition.oauthScope ?? "" }
      : { headers: replace(server.headerNames, secrets.headers) }),
  };
}
```

- [ ] **Step 6: Teach the reconciler to adopt and claim**

Add to `CliMcpReconciler` in `server/features/mcp-servers/cli-reconciler.js` (after `overwrite`):

```js
  /**
   * Takes over the owner's entry `from` (`{ name, hash }`) for server `serverId`, just
   * created from it: AgentPier's entry replaces it under the server's name, only while
   * it is unchanged since the owner saw it. A new name another entry holds stays a
   * taken name for the owner to resolve.
   */
  adopt(cli, serverId, from) {
    const snapshot = this.read(cli);
    const found = snapshot.entries.get(from.name);
    if (!found || found.hash !== from.hash || snapshot.duplicates.has(from.name))
      throw problem(messages.cliFindChanged, 409);
    const want = this.desired(cli).get(serverId);
    if (!want?.entry) return;
    const name = want.definition.name;
    if (name === from.name) {
      this.entries.intend(serverId, cli, name, found.hash);
      this.entries.settle(serverId, cli, found.hash);
      if (found.hash !== want.hash)
        this.apply(cli, [
          { type: "write", serverId, name, entry: want.entry, hash: want.hash, expected: found.hash },
        ]);
      return;
    }
    if (snapshot.entries.has(name)) return;
    this.entries.intend(serverId, cli, name, want.hash);
    this.write(cli, from.name, undefined, found.hash);
    this.write(cli, name, want.entry, undefined);
    this.entries.settle(serverId, cli, want.hash);
  }

  /** The owner's entry in server `serverId`'s way in `cli`: a conflict or a taken name. */
  contested(serverId, cli) {
    const snapshot = this.read(cli);
    const status = this.plan(cli, snapshot).statuses[serverId]?.status;
    if (status !== "conflict" && status !== "name-taken")
      throw problem(messages.cliNotConflict, 409);
    return snapshot.entries.get(this.desired(cli).get(serverId).definition.name);
  }

  /** Records the entry under server `serverId`'s name as AgentPier's while it hashes to `hash`. */
  claim(serverId, cli, hash) {
    const want = this.desired(cli).get(serverId);
    const found = want?.entry && this.read(cli).entries.get(want.definition.name);
    if (!found || found.hash !== hash) throw problem(messages.cliFindChanged, 409);
    this.entries.intend(serverId, cli, want.definition.name, hash);
    this.entries.settle(serverId, cli, hash);
  }
```

- [ ] **Step 7: Run the tests**

Run: `node --test tests/integration/cli-mcp-adoption.test.js tests/integration/cli-mcp-reconciler.test.js tests/integration/cli-mcp-reconciler-recovery.test.js tests/unit/server-i18n-catalogs.test.js && wc -l server/features/mcp-servers/cli-reconciler.js`
Expected: PASS; the reconciler stays below 600 lines.

- [ ] **Step 8: Check and commit**

Run: `npm run lint && npm run format:check && npm run check:structure`

```bash
git add server/features/mcp-servers/cli-finds.js server/features/mcp-servers/cli-adoption.js server/features/mcp-servers/cli-reconciler.js server/lib/i18n/de/mcp-servers.js server/lib/i18n/en/mcp-servers.js tests/integration/cli-mcp-adoption.test.js
git commit -m "feat: adopt MCP entries found in the coding CLIs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The CLI binding service, session start and sandbox grants

Wires the reconciler into AgentPier: a `CliMcpBindings` service that reconciles after every save, binds and unbinds CLIs with validation, resolves conflicts, decorates the list, and prepares each session start. The hook runs **before** `SharedCliProfiles.prepare()`, so the shared-profile projection carries the managed entries to managed accounts in the same launch, and AgentPier only ever writes the canonical profile. This ordering is what keeps the hash baselines in `shared-cli-profiles.json` consistent: the projection compares each managed account with its own baseline, which AgentPier's writes to the canonical profile never touch, so they are never reported as drift (pinned below). Bound stdio servers get nono grants: read for the command, the file it links to and its `#!` interpreter (for `#!/usr/bin/env name` also `name` resolved on the session's PATH), and full access to its `cwd`.

**Files:**

- Create: `server/features/mcp-servers/cli-grants.js`
- Create: `server/features/mcp-servers/cli-bindings.js`
- Modify: `server/lib/i18n/de/mcp-servers.js`, `server/lib/i18n/en/mcp-servers.js` (add `cliTransportUnsupported`, `cliCwdUnsupported`)
- Modify: `server/application/services.js` (construct `cliMcp`; `onSaved`)
- Modify: `server/application/session-lifecycle.js:150`, `server/application/session-reload-lifecycle.js:143-147`
- Test: `tests/unit/cli-mcp-grants.test.js`, `tests/integration/cli-mcp-bindings.test.js`, `tests/blackbox/mcp-cli-session-start.test.js`, `tests/blackbox/session-reload-lifecycle.test.js`

**Interfaces:**

- Consumes: `CliMcpReconciler` (Tasks 5–6), `groupFinds`/`publicFind`, `adoptFinds`/`patchFromNative` (Task 6), `cliSupport`/`centralFromNative`/`clis` (Task 3), `servers.targetsOf`/`setClis` (Task 4), `CentralMcpChanges` (Task 2), `changesStdio`/`requireStdioConfirmation` (Task 2), `addGrant(launch, grant)` (`server/features/nono/sandbox-grants.js:23`), `resolveCommand(command, { pathEnv, exists })` (`command-resolution.js:31`).
- Produces:
  - `interpreters(file, { pathEnv, readHead, exists }) → string[]`, `stdioGrants(definitions, { pathEnv, readHead, realpath, exists }) → Array<{ access: "read" | "allow", path }>`.
  - `class CliMcpBindings({ servers, extensions, changes: () => CentralMcpChanges | null, agentNames: () => Map<id, name>, oauthStatus, warn })` with `reconcileAll()`, `inspectAll()`, `decorate(list) → Promise<server[]>` (adds `clis`, `cliSupport`, `cliStatus`, `users`), `server(id)`, `oauthStates(list) → Promise<{}>` (filled in Task 8), `findGroups()`, `finds()`, `adopt({ keys, names, all })`, `setClis(id, clis, { confirmStdio }) → { clis, added, removed }`, `resolve(id, cli, "overwrite" | "adopt", { confirmStdio })`, `prepare({ account, launch, purpose }) → launch`.
  - `services.cliMcp` (`CliMcpBindings | null`).
  - Errors: `400 MCP_CLI_TRANSPORT_UNSUPPORTED`, `400 MCP_CLI_CWD_UNSUPPORTED`, `409 MCP_STDIO_CONFIRMATION_REQUIRED`.

- [ ] **Step 1: Write the failing grant tests**

```js
// tests/unit/cli-mcp-grants.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  interpreters,
  stdioGrants,
} from "../../server/features/mcp-servers/cli-grants.js";

const heads = {
  "/opt/tools/server.js": "#!/usr/bin/env -S node --no-warnings\nconsole.log(1)\n",
  "/opt/tools/run.sh": "#!/bin/sh -e\necho\n",
  "/opt/tools/bin": "\u007fELF\u0002",
};
const options = {
  pathEnv: "/fake/bin",
  exists: (file) => file === "/fake/bin/node",
  readHead: (file) => {
    if (!Object.hasOwn(heads, file))
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return heads[file];
  },
  realpath: (file) => (file === "/opt/link" ? "/opt/tools/server.js" : file),
};

test("interpreters come from the #! line; env names are resolved on PATH", () => {
  assert.deepEqual(interpreters("/opt/tools/server.js", options), [
    "/usr/bin/env",
    "/fake/bin/node",
  ]);
  assert.deepEqual(interpreters("/opt/tools/run.sh", options), ["/bin/sh"]);
  assert.deepEqual(interpreters("/opt/tools/bin", options), []);
  assert.deepEqual(interpreters("/missing", options), []);
});

test("a stdio server's command, link target, interpreter and cwd are granted; remote ones nothing", () => {
  const grants = stdioGrants(
    [
      { transport: "stdio", command: "/opt/link", cwd: "/work" },
      { transport: "stdio", command: "/opt/tools/run.sh", cwd: null },
      { transport: "stdio", command: "/opt/tools/bin", cwd: null },
      { transport: "http", url: "https://mcp.example.test/mcp" },
    ],
    options,
  );
  assert.deepEqual(grants, [
    { access: "read", path: "/opt/link" },
    { access: "read", path: "/opt/tools/server.js" },
    { access: "read", path: "/usr/bin/env" },
    { access: "read", path: "/fake/bin/node" },
    { access: "allow", path: "/work" },
    { access: "read", path: "/opt/tools/run.sh" },
    { access: "read", path: "/bin/sh" },
    { access: "read", path: "/opt/tools/bin" },
  ]);
});
```

- [ ] **Step 2: Write the failing service tests**

```js
// tests/integration/cli-mcp-bindings.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { CliMcpBindings } from "../../server/features/mcp-servers/cli-bindings.js";
import {
  documents,
  profileLocation,
} from "../../server/features/cli-profiles/configuration.js";
import { cliMcpFixture, http, stdio } from "../helpers/cli-mcp.js";

const service = (f, options = {}) =>
  new CliMcpBindings({
    servers: f.servers,
    extensions: f.extensions,
    warn: (line) => f.warnings.push(line),
    ...options,
  });
const launch = () => ({ command: "/usr/bin/cli", args: [], env: { PATH: "/fake/bin" } });

test("a session start writes its own CLI's entries and grants its bound stdio servers", async (t) => {
  const f = cliMcpFixture(t);
  const cli = service(f);
  f.servers.create(stdio({ cwd: "/tmp/work" }), { bind: [["cli", "codex"]] });
  f.servers.create(stdio({ name: "other", command: "/fake/bin/other" }), {
    bind: [["cli", "claude"]],
  });
  const account = f.accounts.get("local-codex");
  const prepared = await cli.prepare({ account, launch: launch() });
  assert.ok(f.entries("codex").local);
  assert.deepEqual(f.entries("claude"), {});
  const grants = prepared.sandboxGrants.map((grant) => `${grant.access}:${grant.path}`);
  assert.ok(grants.includes("read:/fake/bin/server"));
  assert.ok(grants.includes("allow:/tmp/work"));
  assert.ok(!grants.some((grant) => grant.includes("/fake/bin/other")));
  assert.deepEqual(
    await cli.prepare({ account, launch: launch(), purpose: "login" }),
    launch(),
  );
  assert.deepEqual(
    await cli.prepare({ account: f.accounts.get("local-shell"), launch: launch() }),
    launch(),
  );
});

// Review Focus 4
test("a session starts even when its CLI's configuration cannot be read", async (t) => {
  const f = cliMcpFixture(t);
  const cli = service(f);
  f.servers.create(stdio(), { bind: [["cli", "claude"]] });
  f.raw("claude", "{ broken");
  const account = f.accounts.get("local-claude");
  const prepared = await cli.prepare({ account, launch: launch() });
  assert.ok(prepared.sandboxGrants.some((grant) => grant.path === "/fake/bin/server"));
  assert.equal(f.text("claude"), "{ broken");
  assert.equal(f.warnings.length, 1);
  assert.doesNotMatch(f.warnings[0], /broken|secret|\//);
  f.servers.close();
  assert.deepEqual(await cli.prepare({ account, launch: launch() }), launch());
});

test("binding refuses what a CLI cannot run and asks before a CLI gets a local command", async (t) => {
  const f = cliMcpFixture(t);
  const cli = service(f);
  const sse = f.servers.create(http({ name: "events", transport: "sse" }));
  await assert.rejects(cli.setClis(sse.id, ["codex"]), {
    status: 400,
    code: "MCP_CLI_TRANSPORT_UNSUPPORTED",
  });
  const local = f.servers.create(stdio({ cwd: "/tmp" }));
  await assert.rejects(cli.setClis(local.id, ["claude"], { confirmStdio: true }), {
    status: 400,
    code: "MCP_CLI_CWD_UNSUPPORTED",
  });
  await assert.rejects(cli.setClis(local.id, ["codex"]), {
    code: "MCP_STDIO_CONFIRMATION_REQUIRED",
  });
  assert.deepEqual(f.servers.targetsOf(local.id).clis, []);
  assert.deepEqual(await cli.setClis(local.id, ["codex"], { confirmStdio: true }), {
    clis: ["codex"],
    added: ["codex"],
    removed: [],
  });
  assert.ok(f.entries("codex").local);
  await assert.rejects(cli.setClis(local.id, ["gemini"]), { status: 400 });
  assert.deepEqual(await cli.setClis(local.id, []), {
    clis: [],
    added: [],
    removed: ["codex"],
  });
  assert.deepEqual(f.entries("codex"), {});
});

test("the list shows bound CLIs, support, status and users by name, never a value", async (t) => {
  const f = cliMcpFixture(t);
  const cli = service(f, { agentNames: () => new Map([["home", "Home"]]) });
  const server = f.servers.create(http(), {
    bind: [
      ["agent", "home"],
      ["agent", "gone"],
    ],
  });
  f.write("codex", { docs: { url: "https://owner.example.test/mcp" } });
  await cli.setClis(server.id, ["claude", "codex"]);
  const [listed] = await cli.decorate(f.servers.list());
  assert.deepEqual(listed.clis, ["claude", "codex"]);
  assert.deepEqual(listed.cliSupport, {
    claude: { supported: true },
    codex: { supported: true },
    opencode: { supported: true },
  });
  assert.deepEqual(listed.cliStatus, {
    claude: { status: "written" },
    codex: { status: "name-taken" },
  });
  assert.deepEqual(listed.users, { agents: ["Home"], clis: ["claude", "codex"] });
  assert.doesNotMatch(JSON.stringify(listed), /secret/);
});

test("the owner resolves a conflict by writing AgentPier's version or adopting the edit", async (t) => {
  const f = cliMcpFixture(t);
  const changes = new CentralMcpChanges({ servers: f.servers });
  const cli = service(f, { changes: () => changes });
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  cli.reconcileAll();
  const edited = {
    type: "http",
    url: "https://edited.example.test/mcp",
    headers: { Authorization: "Bearer header-secret" },
  };
  f.write("claude", { docs: edited });
  await cli.resolve(server.id, "claude", "overwrite");
  assert.equal(
    f.entries("claude").docs.url,
    "https://mcp.example.test/mcp?key=query-secret",
  );
  f.write("claude", { docs: edited });
  await cli.resolve(server.id, "claude", "adopt");
  assert.equal(f.servers.definitions()[0].url, "https://edited.example.test/mcp");
  assert.deepEqual(f.entries("claude").docs, edited);
  await assert.rejects(cli.resolve(server.id, "claude", "adopt"), { status: 409 });
  await assert.rejects(cli.resolve(server.id, "claude", "ignore"), { status: 400 });
});

test("managed accounts receive the entries and AgentPier's writes are never drift", async (t) => {
  const f = cliMcpFixture(t);
  const cli = service(f);
  const a = f.accounts.create({ name: "A", tool: "claude" });
  const b = f.accounts.create({ name: "B", tool: "claude" });
  const entries = (account) => {
    const file = documents(profileLocation(f.accounts, account.id))[0].file;
    return JSON.parse(fs.readFileSync(file, "utf8")).mcpServers ?? {};
  };
  const start = async (account) => {
    const prepared = await cli.prepare({
      account,
      launch: { command: "claude", args: [], env: {} },
    });
    f.sharedProfiles.prepare(account, prepared);
  };
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  await start(a);
  await start(b);
  assert.ok(entries(a).docs && entries(b).docs);
  f.servers.update(server.id, { revision: 1, url: "https://moved.example.test/mcp" });
  cli.reconcileAll();
  await start(b);
  await start(a);
  assert.equal(entries(a).docs.url, "https://moved.example.test/mcp");
  await cli.setClis(server.id, []);
  await start(a);
  await start(b);
  assert.equal(entries(a).docs, undefined);
  assert.equal(entries(b).docs, undefined);
  assert.deepEqual(f.sharedProfiles.summary(a.id).conflicts, []);
});
```

```js
// tests/blackbox/mcp-cli-session-start.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  documents,
  profileLocation,
} from "../../server/features/cli-profiles/configuration.js";
import { applicationFixture } from "../helpers/application.js";

test("starting a session writes the bound servers into its CLI, managed accounts included", async (t) => {
  const f = await applicationFixture(t);
  const app = f.application;
  app.accounts.command = () => ({
    command: "/bin/sh",
    args: ["-c", "sleep 30"],
    env: { HOME: f.home, PATH: "/usr/bin:/bin" },
  });
  const account = app.accounts.create({ name: "Managed", tool: "claude" });
  const server = app.mcpServers.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp",
  });
  app.mcpServers.setClis(server.id, ["claude"]);
  assert.equal(fs.existsSync(path.join(f.home, ".claude.json")), false);
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: account.id, cwd: f.home },
  });
  assert.equal(response.status, 201);
  const expected = { type: "http", url: "https://mcp.example.test/mcp" };
  const canonical = JSON.parse(
    fs.readFileSync(path.join(f.home, ".claude.json"), "utf8"),
  );
  assert.deepEqual(canonical.mcpServers.docs, expected);
  // The projection of this very launch carried it into the managed account.
  const managed = documents(profileLocation(app.accounts, account.id))[0].file;
  assert.deepEqual(
    JSON.parse(fs.readFileSync(managed, "utf8")).mcpServers.docs,
    expected,
  );
});
```

In `tests/blackbox/session-reload-lifecycle.test.js` (first test), insert before `const requestId = randomUUID();`:

```js
// A reload prepares the CLI's central MCP entries like a first start.
let cliPrepared = 0;
const prepareCli = app.cliMcp.prepare.bind(app.cliMcp);
app.cliMcp.prepare = async (input) => {
  cliPrepared++;
  return prepareCli(input);
};
```

and after the `until(…, (value) => value.state === "completed")` call add `assert.ok(cliPrepared >= 1);`.

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/unit/cli-mcp-grants.test.js tests/integration/cli-mcp-bindings.test.js tests/blackbox/mcp-cli-session-start.test.js`
Expected: FAIL with `Cannot find module '…/cli-grants.js'` and `…/cli-bindings.js`; the blackbox test fails because `.claude.json` is never written.

- [ ] **Step 4: Add the refusal messages**

`server/lib/i18n/de/mcp-servers.js`:

```js
  cliTransportUnsupported:
    "Diese Coding-CLI unterstützt die Verbindungsart des Servers nicht.",
  cliCwdUnsupported:
    "Diese Coding-CLI kann einen lokalen Befehl nicht in einem Arbeitsverzeichnis starten. Bitte das Arbeitsverzeichnis entfernen oder nur Codex wählen.",
```

`server/lib/i18n/en/mcp-servers.js`:

```js
  cliTransportUnsupported: "This coding CLI does not support the server's connection type.",
  cliCwdUnsupported:
    "This coding CLI cannot start a local command in a working directory. Remove the working directory or choose only Codex.",
```

- [ ] **Step 5: Write the grants**

```js
// server/features/mcp-servers/cli-grants.js
import fs from "node:fs";
import path from "node:path";
import { resolveCommand } from "./command-resolution.js";

function head(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(256);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, 256, 0)).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The programs a script's `#!` line starts: the interpreter, and for
 * `#!/usr/bin/env name` also `name` resolved on `pathEnv`. None for a binary.
 */
export function interpreters(file, { pathEnv = "", readHead = head, exists } = {}) {
  let first;
  try {
    first = readHead(file).split("\n", 1)[0];
  } catch {
    return [];
  }
  if (!first.startsWith("#!")) return [];
  const [program, ...rest] = first.slice(2).trim().split(/\s+/);
  if (!program || !path.isAbsolute(program)) return [];
  if (path.basename(program) !== "env") return [program];
  const name = rest.find((part) => !part.startsWith("-"));
  if (!name) return [program];
  try {
    return [program, resolveCommand(name, { pathEnv, ...(exists ? { exists } : {}) })];
  } catch {
    return [program];
  }
}

/**
 * nono grants for bound stdio servers (docs/sandbox.md): read for the command, the
 * file it links to and its interpreters; full access to its working directory.
 * Remote servers need none.
 */
export function stdioGrants(
  definitions,
  { pathEnv = "", readHead = head, realpath = fs.realpathSync, exists } = {},
) {
  const grants = [];
  for (const definition of definitions) {
    if (definition.transport !== "stdio" || !definition.command) continue;
    const paths = new Set();
    const add = (file) => {
      paths.add(file);
      try {
        paths.add(realpath(file));
      } catch {
        // A missing link target is the command's own problem at start.
      }
    };
    add(definition.command);
    for (const file of [...paths])
      for (const program of interpreters(file, { pathEnv, readHead, exists }))
        add(program);
    for (const file of paths) grants.push({ access: "read", path: file });
    if (definition.cwd) grants.push({ access: "allow", path: definition.cwd });
  }
  return grants;
}
```

- [ ] **Step 6: Write the service**

```js
// server/features/mcp-servers/cli-bindings.js
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { addGrant } from "../nono/sandbox-grants.js";
import { adoptFinds, patchFromNative } from "./cli-adoption.js";
import { groupFinds, publicFind } from "./cli-finds.js";
import { stdioGrants } from "./cli-grants.js";
import { centralFromNative, cliSupport, clis } from "./cli-native.js";
import { CliMcpReconciler } from "./cli-reconciler.js";
import { changesStdio, requireStdioConfirmation } from "./stdio-confirmation.js";

const messages = serverMessages.mcpServers;
const refusals = {
  transport: ["MCP_CLI_TRANSPORT_UNSUPPORTED", messages.cliTransportUnsupported],
  cwd: ["MCP_CLI_CWD_UNSUPPORTED", messages.cliCwdUnsupported],
};

/**
 * Central MCP servers in the coding CLIs: each `cli` binding becomes an entry in the
 * CLI's canonical native profile (`local-<cli>`), which the shared-profile projection
 * carries to every managed account of that CLI. Runs after every saved change and
 * before every session start; never shows or logs a header or environment value.
 */
export class CliMcpBindings {
  constructor({
    servers,
    extensions,
    changes = () => null,
    agentNames = () => new Map(),
    oauthStatus = null,
    warn = console.warn,
  }) {
    Object.assign(this, { servers, changes, agentNames, oauthStatus, warn });
    this.reconciler = new CliMcpReconciler({
      servers,
      locate: (cli) => extensions.locations(`local-${cli}`),
      configs: (locations) => extensions.configs(locations),
      warn,
    });
  }
  /** Brings every CLI in step with the store; one CLI's file never stops the others. */
  reconcileAll() {
    return Object.fromEntries(clis.map((cli) => [cli, this.reconciler.reconcile(cli)]));
  }
  inspectAll() {
    return Object.fromEntries(clis.map((cli) => [cli, this.reconciler.inspect(cli)]));
  }
  /** The list as responses show it: bound CLIs, their support and status, and users. */
  async decorate(list) {
    const results = this.inspectAll();
    const names = this.agentNames();
    const oauth = await this.oauthStates(list);
    return list.map((server) => {
      const targets = this.servers.targetsOf(server.id);
      return {
        ...server,
        clis: targets.clis,
        cliSupport: Object.fromEntries(clis.map((cli) => [cli, cliSupport(cli, server)])),
        cliStatus: Object.fromEntries(
          targets.clis.map((cli) => [
            cli,
            {
              ...(results[cli].statuses[server.id] ?? { status: "pending" }),
              ...(oauth[cli]?.[server.id] ? { oauth: oauth[cli][server.id] } : {}),
            },
          ]),
        ),
        users: {
          agents: targets.agents.map((id) => names.get(id)).filter(Boolean),
          clis: targets.clis,
        },
      };
    });
  }
  async server(id) {
    return (await this.decorate([this.servers.get(id)]))[0];
  }
  /** OAuth login state per CLI and server id (Task 8). */
  async oauthStates() {
    return {};
  }
  findGroups() {
    return groupFinds(
      this.inspectAll(),
      this.servers.list().map((server) => server.name),
    );
  }
  finds() {
    return this.findGroups().map(publicFind);
  }
  adopt(body = {}) {
    const result = adoptFinds({
      servers: this.servers,
      reconciler: this.reconciler,
      groups: this.findGroups(),
      keys: body.keys,
      names: body.names ?? {},
      all: body.all === true,
    });
    this.reconcileAll();
    return result;
  }
  /** Binds server `id` to exactly `wanted`; a CLI that cannot run it is refused. */
  async setClis(id, wanted, { confirmStdio = false } = {}) {
    if (!Array.isArray(wanted) || wanted.some((cli) => !clis.includes(cli)))
      throw problem(messages.invalidTarget, 400);
    const server = this.servers.get(id);
    const current = this.servers.targetsOf(id).clis;
    const next = clis.filter((cli) => wanted.includes(cli));
    const added = next.filter((cli) => !current.includes(cli));
    for (const cli of added) {
      const support = cliSupport(cli, server);
      if (support.supported) continue;
      const [code, message] = refusals[support.reason];
      throw Object.assign(problem(message, 400), { code });
    }
    if (server.transport === "stdio" && added.length)
      requireStdioConfirmation(confirmStdio === true);
    this.servers.setClis(id, next);
    this.reconcileAll();
    return { clis: next, added, removed: current.filter((cli) => !next.includes(cli)) };
  }
  /**
   * The owner's choice for a conflict or a taken name in `cli`: "overwrite" writes
   * AgentPier's version (conflicts only); "adopt" moves the owner's entry into the
   * central server (which every bound CLI and agent then gets) and makes it AgentPier's.
   */
  async resolve(id, cli, choice, { confirmStdio = false } = {}) {
    if (!clis.includes(cli) || !["overwrite", "adopt"].includes(choice))
      throw problem(messages.invalidRequest, 400);
    if (choice === "overwrite") {
      this.reconciler.overwrite(id, cli);
      return;
    }
    const found = this.reconciler.contested(id, cli);
    const parsed = centralFromNative(cli, found.entry);
    if (!parsed.ok) throw problem(messages.cliChangeNotAdoptable, 409);
    const server = this.servers.get(id);
    const patch = patchFromNative(server, cli, parsed);
    if (changesStdio(server, patch)) requireStdioConfirmation(confirmStdio === true);
    const changes = this.changes();
    if (changes) await changes.update(id, patch, { confirmStdio: true });
    else this.servers.update(id, patch);
    this.reconciler.claim(id, cli, found.hash);
    this.reconcileAll();
  }
  /**
   * Before a session of `account` starts: its CLI is brought in step (a missing managed
   * entry is restored, a conflict left alone) and the sandbox is granted what each
   * bound stdio server runs. Never fails the launch; problems are logged by code.
   */
  async prepare({ account, launch, purpose }) {
    if (purpose === "login" || !clis.includes(account.tool)) return launch;
    try {
      this.reconciler.reconcile(account.tool);
    } catch (error) {
      this.warn(
        `MCP servers for ${account.tool} could not be prepared (${error?.code || "ERROR"}).`,
      );
    }
    try {
      const bound = new Set(this.servers.bindings("cli", account.tool));
      const definitions = this.servers
        .definitions()
        .filter(
          (definition) =>
            bound.has(definition.id) &&
            definition.transport === "stdio" &&
            cliSupport(account.tool, definition).supported,
        );
      let next = launch;
      for (const grant of stdioGrants(definitions, { pathEnv: launch.env?.PATH ?? "" }))
        next = addGrant(next, grant);
      return next;
    } catch (error) {
      this.warn(
        `MCP sandbox grants for ${account.tool} are missing (${error?.code || "ERROR"}).`,
      );
      return launch;
    }
  }
}
```

- [ ] **Step 7: Wire the service and the launch hooks**

In `server/application/services.js` add `import { CliMcpBindings } from "../features/mcp-servers/cli-bindings.js";`, extend the facade construction from Task 2 with `onSaved`, and construct the service right after it:

```js
const mcpServerChanges =
  mcpServers &&
  new CentralMcpChanges({
    servers: mcpServers,
    agents: () => services.assistantMcpChanges,
    maintenance: () => !!services.assistants?.maintenance,
    // Every saved change is written into the bound CLIs at once.
    onSaved: async () => services.cliMcp?.reconcileAll(),
  });
const cliMcp =
  mcpServers &&
  new CliMcpBindings({
    servers: mcpServers,
    extensions,
    changes: () => services.mcpServerChanges,
    agentNames: () =>
      new Map(
        (services.assistants?.store.listAssistants() || []).map((profile) => [
          profile.id,
          profile.name,
        ]),
      ),
  });
```

and add `cliMcp,` to the `services` object.

In `server/application/session-lifecycle.js` replace line 150

```js
if (!login) sharedProfiles?.prepare(account, launch);
```

with

```js
// Central MCP servers go into the CLI's canonical profile first, so the shared
// profile projection below carries them into a managed account in this launch.
if (!login && services.cliMcp)
  launch = await services.cliMcp.prepare({ account, launch });
if (!login) sharedProfiles?.prepare(account, launch);
```

In `server/application/session-reload-lifecycle.js` replace lines 143-147

```js
sharedProfiles?.prepare(account, plan.launch);
await requests.discard(session.id);
await memoryIntegration.discard(session.id);
await sshIntegration?.discard(session.id);
let launch = plan.launch;
```

with

```js
let launch = services.cliMcp
  ? await services.cliMcp.prepare({ account, launch: plan.launch })
  : plan.launch;
sharedProfiles?.prepare(account, launch);
await requests.discard(session.id);
await memoryIntegration.discard(session.id);
await sshIntegration?.discard(session.id);
```

- [ ] **Step 8: Run the tests**

Run: `node --test tests/unit/cli-mcp-grants.test.js tests/integration/cli-mcp-bindings.test.js tests/blackbox/mcp-cli-session-start.test.js tests/blackbox/session-reload-lifecycle.test.js tests/blackbox/session-selection.test.js tests/unit/mcp-central-changes.test.js tests/unit/server-i18n-catalogs.test.js`
Expected: PASS. The blackbox test pins the hook order: the managed account's file has the entry only because the hook runs before `sharedProfiles.prepare`.

- [ ] **Step 9: Check and commit**

Run: `npm run lint && npm run format:check && npm run check:structure`

```bash
git add server/features/mcp-servers/cli-grants.js server/features/mcp-servers/cli-bindings.js server/lib/i18n/de/mcp-servers.js server/lib/i18n/en/mcp-servers.js server/application/services.js server/application/session-lifecycle.js server/application/session-reload-lifecycle.js tests/unit/cli-mcp-grants.test.js tests/integration/cli-mcp-bindings.test.js tests/blackbox/mcp-cli-session-start.test.js tests/blackbox/session-reload-lifecycle.test.js
git commit -m "feat: write bound MCP servers into the CLIs and grant them in sandboxes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Routes, audit and CLI OAuth status

Exposes the service over HTTP, audits CLI bindings, conflict choices and adoptions like AGENTPIER-41 (names and CLIs only), lets the `MCP_CLI_*` codes reach the browser, and adds per-CLI OAuth status: read from `codex mcp list --json` (Task 1), otherwise the CLI's login command.

**Files:**

- Create: `server/features/mcp-servers/cli-oauth-status.js`
- Create: `server/http/routes/mcp-cli.js`
- Modify: `server/features/mcp-servers/cli-bindings.js` (`oauthStates`)
- Modify: `server/http/routes/mcp-servers.js` (mount CLI routes; decorate the list)
- Modify: `server/features/audit/audit-schema.js` (`changeFields` from PR #229 gains `clis`; new `clis`, `resolution`, `adopted` details)
- Modify: `server/http/responses.js:50-53` (pass `MCP_CLI_*` codes)
- Modify: `server/application/services.js` (`oauthStatus`)
- Test: `tests/unit/cli-oauth-status.test.js`, `tests/unit/audit-schema.test.js`, `tests/blackbox/mcp-cli-routes.test.js`

**Interfaces:**

- Consumes: `CliMcpBindings` (Task 7), `codexAuthStatus` fixture (Task 1), `auditMcp`/`replyStdioConfirmation` (Task 2), `services.tools()` (`server/app.js:82`), `accounts.environment(id)`.
- Produces:
  - `codexAuthStates`, `loginCommand(cli, name)`, `class CliOAuthStatus({ tools, accounts, run, now })` with `codex() → Promise<{ [name]: "connected" | "login-required" | "unknown" }>`.
  - `cliStatus[cli].oauth = { state, command }` on OAuth servers in `GET /api/mcp-servers`.
  - Routes: `GET /api/mcp-servers/cli-finds` → `{ finds }`; `POST /api/mcp-servers/cli-finds/adopt` `{ keys?, names?, all? }` → `{ adopted, failed }`; `PUT /api/mcp-servers/:id/clis` `{ clis, confirmStdio? }` → decorated server; `POST /api/mcp-servers/:id/clis/:cli/resolve` `{ choice: "overwrite" | "adopt", confirmStdio? }` → decorated server.
  - Audit: `mcp.updated` `{ fields: ["clis"], clis, stdioConfirmed }` or `{ fields: ["clis"], clis: [cli], resolution }`; `mcp.created` `{ transport, clis, adopted: true }`.

- [ ] **Step 1: Write the failing unit tests**

```js
// tests/unit/cli-oauth-status.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { codexAuthStatus } from "../fixtures/cli-mcp-shapes.js";
import {
  CliOAuthStatus,
  codexAuthStates,
  loginCommand,
} from "../../server/features/mcp-servers/cli-oauth-status.js";

const accounts = { environment: (id) => ({ HOME: `/home/${id}` }), home: "/home" };
const codex = [{ id: "codex", installed: true, path: "/fake/codex" }];

test("the mapping follows what the Codex contract pinned", () => {
  assert.equal(codexAuthStates[codexAuthStatus.loggedIn], "connected");
  assert.equal(codexAuthStates[codexAuthStatus.loggedOut], "login-required");
});

test("Codex status is read at most every half minute and mapped to three states", async () => {
  const calls = [];
  let now = 0;
  const status = new CliOAuthStatus({
    tools: () => codex,
    accounts,
    now: () => now,
    run: async (file, args, options) => {
      calls.push([file, args, options.env.HOME]);
      return {
        stdout: JSON.stringify([
          {
            name: "docs",
            auth_status: codexAuthStatus.loggedIn,
            transport: { http_headers: { A: "value-secret" } },
          },
          { name: "search", auth_status: codexAuthStatus.loggedOut },
          { name: "plain", auth_status: "bearer_token" },
        ]),
      };
    },
  });
  assert.deepEqual(await status.codex(), {
    docs: "connected",
    search: "login-required",
    plain: "unknown",
  });
  await status.codex();
  now = 31000;
  await status.codex();
  const call = ["/fake/codex", ["mcp", "list", "--json"], "/home/local-codex"];
  assert.deepEqual(calls, [call, call]);
});

test("a missing or failing Codex reports nothing", async () => {
  assert.deepEqual(await new CliOAuthStatus({ tools: () => [], accounts }).codex(), {});
  const failing = new CliOAuthStatus({
    tools: () => codex,
    accounts,
    run: async () => ({ stdout: "not json" }),
  });
  assert.deepEqual(await failing.codex(), {});
});

test("each CLI's own login command", () => {
  assert.equal(loginCommand("claude", "docs"), "/mcp");
  assert.equal(loginCommand("codex", "docs"), "codex mcp login docs");
  assert.equal(loginCommand("opencode", "docs"), "opencode mcp auth docs");
});
```

Append to `tests/unit/audit-schema.test.js` (it already imports `auditEvent`):

```js
test("MCP CLI audits keep the CLIs, the conflict choice and adoption only", () => {
  const base = {
    action: "mcp.updated",
    resourceType: "mcp",
    resourceId: "s1",
    source: "user",
    outcome: "success",
  };
  const event = auditEvent({
    ...base,
    details: {
      fields: ["clis", "secret"],
      clis: ["claude", "gemini", "codex"],
      resolution: "adopt",
      adopted: true,
      url: "https://x.example.test/mcp",
      headers: { Authorization: "Bearer value" },
    },
  });
  assert.deepEqual(event.details, {
    fields: ["clis"],
    clis: ["claude", "codex"],
    resolution: "adopt",
    adopted: true,
  });
  assert.equal(
    auditEvent({ ...base, details: { resolution: "delete" } }).details.resolution,
    undefined,
  );
  assert.equal(
    auditEvent({
      ...base,
      resourceType: "assistant",
      action: "assistant.updated",
      details: { clis: ["claude"] },
    }).details.clis,
    undefined,
  );
});
```

- [ ] **Step 2: Write the failing blackbox test**

```js
// tests/blackbox/mcp-cli-routes.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

const secrets = ["header-secret", "query-secret", "found-secret"];
async function read(response) {
  const text = await response.text();
  for (const secret of secrets) assert.ok(!text.includes(secret), secret);
  return text ? JSON.parse(text) : null;
}

test("CLI bindings, conflicts and finds over HTTP carry names only and are audited", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  const claude = path.join(f.home, ".claude.json");
  const codex = path.join(f.home, ".codex/config.toml");
  const created = await read(
    await f.request("/api/mcp-servers", {
      method: "POST",
      body: {
        name: "docs",
        transport: "http",
        url: "https://mcp.example.test/mcp?k=query-secret",
        headers: { Authorization: "Bearer header-secret" },
      },
    }),
  );
  let response = await f.request(`/api/mcp-servers/${created.id}/clis`, {
    method: "PUT",
    body: { clis: ["claude"] },
  });
  assert.equal(response.status, 200);
  const bound = await read(response);
  assert.deepEqual(
    [bound.clis, bound.cliStatus],
    [["claude"], { claude: { status: "written" } }],
  );
  assert.equal(
    JSON.parse(fs.readFileSync(claude, "utf8")).mcpServers.docs.headers.Authorization,
    "Bearer header-secret",
  );

  const sse = await read(
    await f.request("/api/mcp-servers", {
      method: "POST",
      body: { name: "events", transport: "sse", url: "https://mcp.example.test/sse" },
    }),
  );
  response = await f.request(`/api/mcp-servers/${sse.id}/clis`, {
    method: "PUT",
    body: { clis: ["codex"] },
  });
  assert.equal(response.status, 400);
  const refusal = await read(response);
  assert.equal(refusal.code, "MCP_CLI_TRANSPORT_UNSUPPORTED");
  assert.equal(refusal.messageKey, "mcpServers.cliTransportUnsupported");

  const data = JSON.parse(fs.readFileSync(claude, "utf8"));
  data.mcpServers.docs.url = "https://edited.example.test/mcp";
  fs.writeFileSync(claude, JSON.stringify(data));
  const listed = await read(await f.request("/api/mcp-servers"));
  assert.deepEqual(listed.find((s) => s.id === created.id).cliStatus, {
    claude: { status: "conflict" },
  });
  response = await f.request(`/api/mcp-servers/${created.id}/clis/claude/resolve`, {
    method: "POST",
    body: { choice: "overwrite" },
  });
  assert.deepEqual((await read(response)).cliStatus, { claude: { status: "written" } });

  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(
    codex,
    '[mcp_servers."my.search"]\nurl = "https://search.example.test/mcp"\n[mcp_servers."my.search".http_headers]\nAuthorization = "Bearer found-secret"\n',
  );
  const { finds } = await read(await f.request("/api/mcp-servers/cli-finds"));
  assert.deepEqual(
    finds.map((find) => [find.name, find.proposedName, find.clis, find.headerNames]),
    [["my.search", "my-search", ["codex"], ["Authorization"]]],
  );
  const adopted = await read(
    await f.request("/api/mcp-servers/cli-finds/adopt", {
      method: "POST",
      body: { keys: [finds[0].key] },
    }),
  );
  assert.deepEqual(
    adopted.adopted.map((s) => [s.name, s.clis]),
    [["my-search", ["codex"]]],
  );
  assert.deepEqual((await read(await f.request("/api/mcp-servers/cli-finds"))).finds, []);

  assert.equal(
    (await f.request(`/api/mcp-servers/${created.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(JSON.parse(fs.readFileSync(claude, "utf8")).mcpServers.docs, undefined);

  const { events } = await read(await f.request("/api/audit"));
  const has = (action, details) =>
    events.some(
      (event) =>
        event.action === action &&
        Object.entries(details).every(
          ([key, value]) => JSON.stringify(event.details[key]) === JSON.stringify(value),
        ),
    );
  assert.ok(has("mcp.updated", { fields: ["clis"], clis: ["claude"] }));
  assert.ok(has("mcp.updated", { clis: ["claude"], resolution: "overwrite" }));
  assert.ok(has("mcp.created", { clis: ["codex"], adopted: true }));
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/unit/cli-oauth-status.test.js tests/unit/audit-schema.test.js tests/blackbox/mcp-cli-routes.test.js`
Expected: FAIL — module `cli-oauth-status.js` missing, `details.clis` dropped by the schema, `PUT /api/mcp-servers/:id/clis` answers 404.

- [ ] **Step 4: Write the OAuth status reader**

```js
// server/features/mcp-servers/cli-oauth-status.js
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
// `auth_status` of `codex mcp list --json` (docs/cli-mcp-qualification.md).
export const codexAuthStates = { o_auth: "connected", not_logged_in: "login-required" };
const statusTtlMs = 30000;

/** The command that logs server `name` in, in the CLI itself. */
export function loginCommand(cli, name) {
  if (cli === "claude") return "/mcp";
  if (cli === "codex") return `codex mcp login ${name}`;
  return `opencode mcp auth ${name}`;
}

/**
 * OAuth login state in Codex, the only CLI with machine-readable status:
 * `{ [name]: "connected" | "login-required" | "unknown" }`, cached for half a minute.
 * Runs the installed Codex on the owner's canonical profile; its output (which lists
 * header values) never leaves this method.
 */
export class CliOAuthStatus {
  constructor({ tools, accounts, run = execute, now = Date.now }) {
    Object.assign(this, { tools, accounts, run, now });
    this.cache = null;
  }
  codex() {
    if (this.cache && this.now() - this.cache.at < statusTtlMs) return this.cache.promise;
    const promise = this.read().catch(() => ({}));
    this.cache = { at: this.now(), promise };
    return promise;
  }
  async read() {
    const tool = this.tools().find((item) => item.id === "codex" && item.installed);
    if (!tool) return {};
    const { stdout } = await this.run(tool.path, ["mcp", "list", "--json"], {
      env: this.accounts.environment("local-codex"),
      cwd: this.accounts.home,
      timeout: 10000,
      maxBuffer: 1 << 20,
    });
    const list = JSON.parse(stdout);
    return Object.fromEntries(
      (Array.isArray(list) ? list : [])
        .filter((entry) => typeof entry?.name === "string")
        .map((entry) => [entry.name, codexAuthStates[entry.auth_status] ?? "unknown"]),
    );
  }
}
```

In `server/features/mcp-servers/cli-bindings.js` import `{ loginCommand }` from `./cli-oauth-status.js` and replace `oauthStates()` with:

```js
  /**
   * `{ [cli]: { [serverId]: { state, command } } }` for OAuth servers bound to a CLI:
   * Codex reports its login state; for the others the owner sees the login command.
   */
  async oauthStates(list) {
    const oauth = list.filter((server) => server.auth === "oauth" && server.transport !== "stdio");
    const out = {};
    for (const cli of clis) {
      const bound = new Set(this.servers.bindings("cli", cli));
      const mine = oauth.filter((server) => bound.has(server.id));
      if (!mine.length) continue;
      const known = cli === "codex" && this.oauthStatus ? await this.oauthStatus.codex() : {};
      out[cli] = Object.fromEntries(
        mine.map((server) => [
          server.id,
          { state: known[server.name] ?? "unknown", command: loginCommand(cli, server.name) },
        ]),
      );
    }
    return out;
  }
```

In `server/application/services.js` add `import { CliOAuthStatus } from "../features/mcp-servers/cli-oauth-status.js";` and pass to `new CliMcpBindings({ … })`:

```js
      oauthStatus: new CliOAuthStatus({ tools: () => services.tools?.() ?? [], accounts }),
```

- [ ] **Step 5: Audit details and response codes**

In `server/features/audit/audit-schema.js` add `"clis",` to PR #229's `changeFields` set and insert after PR #229's MCP block (the one that copies `transport`, `fields` and `stdioConfirmed`):

```js
// CLI bindings name the CLIs, how the owner resolved a conflict and whether a server
// was adopted from the CLIs; never an entry or a value.
if (input.resourceType === "mcp") {
  if (Array.isArray(details.clis))
    event.details.clis = details.clis.filter((cli) =>
      ["claude", "codex", "opencode"].includes(cli),
    );
  if (["overwrite", "adopt"].includes(details.resolution))
    event.details.resolution = details.resolution;
  if (typeof details.adopted === "boolean") event.details.adopted = details.adopted;
}
```

In `server/http/responses.js` change `/^(?:SSH|ARTIFACT|PIPELINE)_[A-Z_]+$/` to `/^(?:SSH|ARTIFACT|PIPELINE|MCP_CLI)_[A-Z_]+$/`.

- [ ] **Step 6: Write the routes**

```js
// server/http/routes/mcp-cli.js
import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Central MCP servers in the coding CLIs: the CLIs a server is bound to, the owner's
 * choice for a conflict or a taken name, and entries found in the CLIs. Responses
 * and audit events carry names only, never a header or environment value.
 */
export function mcpCliRoutes(services, { auditMcp, replyStdioConfirmation }) {
  const router = Router();
  const cli = () => {
    if (!services.cliMcp) throw assistantProblem("unavailable", 503);
    return services.cliMcp;
  };
  router.get("/mcp-servers/cli-finds", (_req, res) => res.json({ finds: cli().finds() }));
  router.post("/mcp-servers/cli-finds/adopt", (req, res) => {
    const body = record(req.body) ? req.body : {};
    const result = cli().adopt({
      keys: body.keys,
      names: body.names,
      all: body.all === true,
    });
    for (const server of result.adopted)
      auditMcp("mcp.created", server.id, {
        transport: server.transport,
        clis: server.clis,
        adopted: true,
      });
    res.json(result);
  });
  router.put("/mcp-servers/:id/clis", async (req, res) => {
    const body = record(req.body) ? req.body : {};
    let result;
    try {
      result = await cli().setClis(req.params.id, body.clis, {
        confirmStdio: body.confirmStdio === true,
      });
    } catch (error) {
      if (replyStdioConfirmation(res, error)) return;
      throw error;
    }
    auditMcp("mcp.updated", req.params.id, {
      fields: ["clis"],
      clis: result.clis,
      stdioConfirmed: result.added.length > 0 && body.confirmStdio === true,
    });
    res.json(await cli().server(req.params.id));
  });
  router.post("/mcp-servers/:id/clis/:cli/resolve", async (req, res) => {
    const body = record(req.body) ? req.body : {};
    try {
      await cli().resolve(req.params.id, req.params.cli, body.choice, {
        confirmStdio: body.confirmStdio === true,
      });
    } catch (error) {
      if (replyStdioConfirmation(res, error)) return;
      throw error;
    }
    auditMcp("mcp.updated", req.params.id, {
      fields: ["clis"],
      clis: [req.params.cli],
      resolution: body.choice,
    });
    res.json(await cli().server(req.params.id));
  });
  return router;
}
```

In `server/http/routes/mcp-servers.js` import `{ mcpCliRoutes }` from `./mcp-cli.js`, add right after the `no-store` middleware:

```js
router.use(mcpCliRoutes(services, { auditMcp, replyStdioConfirmation }));
```

and replace the list route with:

```js
// OAuth servers carry their agent login status (see McpOAuthLogins.decorate); every
// server its CLI bindings, their status and its users (CliMcpBindings.decorate).
router.get("/mcp-servers", async (_req, res) => {
  let list = changes().list();
  if (services.assistantMcpOAuth) list = await services.assistantMcpOAuth.decorate(list);
  res.json(services.cliMcp ? await services.cliMcp.decorate(list) : list);
});
```

- [ ] **Step 7: Run the tests**

Run: `node --test tests/unit/cli-oauth-status.test.js tests/unit/audit-schema.test.js tests/blackbox/mcp-cli-routes.test.js tests/blackbox/mcp-server-routes.test.js tests/blackbox/mcp-servers-without-agents.test.js tests/blackbox/mcp-server-audit.test.js tests/integration/cli-mcp-bindings.test.js`
Expected: PASS.

- [ ] **Step 8: Check and commit**

Run: `npm run lint && npm run format:check && npm run check:structure`

```bash
git add server/features/mcp-servers/cli-oauth-status.js server/features/mcp-servers/cli-bindings.js server/http/routes/mcp-cli.js server/http/routes/mcp-servers.js server/features/audit/audit-schema.js server/http/responses.js server/application/services.js tests/unit/cli-oauth-status.test.js tests/unit/audit-schema.test.js tests/blackbox/mcp-cli-routes.test.js
git commit -m "feat: serve and audit MCP bindings to the coding CLIs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Coding CLIs in the form, per-CLI status, conflict choices and users

The server form gets a **Coding CLIs** block (three checkboxes; disabled with the reason where the CLI cannot run the server), each server shows its users ("Agents: Home, Lead · CLIs: Claude Code, Codex") and per bound CLI its status with the owner's choices: **Write AgentPier's version** / **Adopt the change** for a conflict, **Adopt** for a taken name, the CLI's login command for OAuth. All copy in German and English. The full `mcp-cli` catalog (including the keys Task 10 uses) is created here.

**Files:**

- Create: `web/lib/i18n/de/mcp-cli.js`, `web/lib/i18n/en/mcp-cli.js`, `web/lib/i18n/messages/mcp-cli.js`
- Create: `web/features/mcp-servers/cli-api.js`, `web/features/mcp-servers/cli-support.js`, `web/features/mcp-servers/McpCliChoices.jsx`, `web/features/mcp-servers/McpCliStatus.jsx`, `web/features/mcp-servers/mcp-cli.css`
- Modify: `web/features/mcp-servers/McpServerForm.jsx`, `web/features/mcp-servers/McpServersSettings.jsx`, `web/features/mcp-servers/StdioConfirmation.jsx`
- Modify: `web/lib/i18n/de/mcp-servers.js:3-4`, `web/lib/i18n/en/mcp-servers.js:3-4` (`description`)
- Test: `tests/unit/mcp-cli-support.test.js`, `tests/browser/mcp-cli-bindings.spec.js`

**Interfaces:**

- Consumes: the decorated list from Task 8 (`clis`, `cliSupport`, `cliStatus: { [cli]: { status, reason?, oauth?: { state, command } } }`, `users: { agents, clis }`), `PUT /api/mcp-servers/:id/clis`, `POST /api/mcp-servers/:id/clis/:cli/resolve`; `names` (`web/lib/providers.js`), `stdioConfirmationRequired` (`stdio-confirmation.js`), `api` (`web/lib/api.js`).
- Produces:
  - `mcpCliCopy` (reactive, `web/lib/i18n/messages/mcp-cli.js`).
  - `cliApi = { setClis(id, clis, confirmStdio), resolve(id, cli, choice, confirmStdio), finds(), adopt(body) }`.
  - `clis`, `cliSupport(cli, { transport, cwd })` (browser mirror of the server rule).
  - `McpCliChoices({ id, target, selected, onChange })`, `McpCliStatus({ server, onChanged })`, `StdioConfirmation({ binding, cli, busy, onConfirm, onCancel })`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/mcp-cli-support.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  cliSupport as server,
  clis,
} from "../../server/features/mcp-servers/cli-native.js";
import {
  cliSupport as browser,
  clis as browserClis,
} from "../../web/features/mcp-servers/cli-support.js";

test("the form disables exactly what the server refuses", () => {
  assert.deepEqual(browserClis, clis);
  for (const cli of clis)
    for (const transport of ["http", "sse", "stdio"])
      for (const cwd of [null, "", "/tmp"])
        assert.deepEqual(
          browser(cli, { transport, cwd }),
          server(cli, { transport, cwd }),
          `${cli}/${transport}/${cwd}`,
        );
});
```

Append to `tests/browser/mcp-cli-bindings.spec.js`:

```js
const bound = (extra = {}) =>
  header({
    clis: ["claude", "codex"],
    cliSupport: {
      claude: { supported: true },
      codex: { supported: true },
      opencode: { supported: true },
    },
    cliStatus: { claude: { status: "written" }, codex: { status: "conflict" } },
    users: { agents: ["Home"], clis: ["claude", "codex"] },
    ...extra,
  });

test("the form offers coding CLIs, explains a disabled one and saves the choice", async ({
  page,
}) => {
  const state = await setup(page);
  state.handle = async ({ route, request, path, body }) => {
    if (path === "/api/mcp-servers" && request.method() === "POST") {
      state.servers.push(
        header({ name: body.name, transport: body.transport, url: body.url }),
      );
      return route.fulfill({ status: 201, json: state.servers[0] });
    }
    if (path === "/api/mcp-servers/s1/clis" && request.method() === "PUT") {
      state.servers[0] = bound({
        clis: body.clis,
        cliStatus: { claude: { status: "written" } },
        users: { agents: [], clis: body.clis },
      });
      return route.fulfill({ json: state.servers[0] });
    }
    return false;
  };
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("region", { name: "MCP servers" })
    .getByRole("button", { name: "Add MCP server" })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("docs");
  await dialog.getByRole("radio", { name: "SSE", exact: true }).check();
  await dialog.getByLabel("Address").fill("https://mcp.example.test/sse");
  const codex = dialog.getByRole("checkbox", { name: "Codex" });
  await expect(codex).toBeDisabled();
  await expect(dialog.getByText("Codex does not support SSE servers.")).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Claude Code" }).check();
  await dialog.getByRole("button", { name: "Save server" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests.find((r) => r.path === "/api/mcp-servers/s1/clis").body).toEqual({
    clis: ["claude"],
  });
  await expect(page.getByText("Claude Code: written")).toBeVisible();
  await expect(page.getByText("CLIs: Claude Code")).toBeVisible();
});

test("a local command for a CLI is confirmed before anything is saved", async ({
  page,
}) => {
  const state = await setup(page);
  state.handle = async ({ route, request, path, body }) => {
    if (path === "/api/mcp-servers" && request.method() === "POST") {
      state.servers.push(
        header({
          name: body.name,
          transport: "stdio",
          url: undefined,
          command: body.command,
          args: [],
          headerNames: [],
          envNames: [],
        }),
      );
      return route.fulfill({ status: 201, json: state.servers[0] });
    }
    if (path === "/api/mcp-servers/s1/clis")
      return route.fulfill({ json: bound({ transport: "stdio", clis: body.clis }) });
    return false;
  };
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("region", { name: "MCP servers" })
    .getByRole("button", { name: "Add MCP server" })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("local");
  await dialog.getByRole("radio", { name: "Local command (stdio)" }).check();
  await dialog.getByLabel("Command").fill("/usr/bin/true");
  await dialog.getByRole("checkbox", { name: "Codex" }).check();
  await dialog.getByRole("button", { name: "Save server" }).click();
  await expect(
    dialog.getByRole("alertdialog", { name: "Give coding CLIs a local command?" }),
  ).toBeVisible();
  expect(state.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Confirm and save" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests.find((r) => r.method === "POST").body.confirmStdio).toBe(true);
  expect(state.requests.find((r) => r.method === "PUT").body).toEqual({
    clis: ["codex"],
    confirmStdio: true,
  });
});

test("a conflict offers both choices and an OAuth server the CLI's login command", async ({
  page,
}) => {
  const state = await setup(page, {
    servers: [
      bound(),
      header({
        id: "s2",
        name: "search",
        auth: "oauth",
        headerNames: [],
        clis: ["codex", "opencode"],
        cliSupport: {
          claude: { supported: true },
          codex: { supported: true },
          opencode: { supported: true },
        },
        cliStatus: {
          codex: {
            status: "written",
            oauth: { state: "login-required", command: "codex mcp login search" },
          },
          opencode: {
            status: "name-taken",
            oauth: { state: "unknown", command: "opencode mcp auth search" },
          },
        },
        users: { agents: [], clis: ["codex", "opencode"] },
      }),
    ],
  });
  state.handle = async ({ route, path, body }) => {
    if (path === "/api/mcp-servers/s1/clis/codex/resolve") {
      state.servers[0] = bound({
        cliStatus: { claude: { status: "written" }, codex: { status: "written" } },
      });
      return route.fulfill({ json: state.servers[0] });
    }
    return false;
  };
  await page.goto(baseURL + "/accounts");
  await expect(page.getByText("Agents: Home · CLIs: Claude Code, Codex")).toBeVisible();
  await expect(page.getByText("Codex: edited by hand in the CLI")).toBeVisible();
  await expect(
    page.getByText("Log in once in Codex: run codex mcp login search"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Adopt search from OpenCode" }),
  ).toBeVisible();
  const docs = page
    .locator(".mcp-item")
    .filter({ has: page.getByText("docs", { exact: true }) });
  await page
    .getByRole("button", { name: "Write AgentPier's version of docs to Codex" })
    .click();
  await expect(docs.getByText("Codex: written")).toBeVisible();
  expect(state.requests.find((r) => r.path.endsWith("/resolve")).body).toEqual({
    choice: "overwrite",
  });
  await expect(
    page.getByRole("button", { name: "Adopt the change to docs from Codex" }),
  ).toHaveCount(0);
});

test("the CLI statuses read in German", async ({ page }) => {
  await setup(page, { language: "de", servers: [bound()] });
  await page.goto(baseURL + "/accounts");
  await expect(page.getByText("Codex: in der CLI von Hand geändert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Änderung an docs aus Codex übernehmen" }),
  ).toBeVisible();
  await expect(page.getByText("Agenten: Home · CLIs: Claude Code, Codex")).toBeVisible();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/mcp-cli-support.test.js; npm run build && npx playwright test tests/browser/mcp-cli-bindings.spec.js --project=chromium`
Expected: the unit test fails with `Cannot find module '…/web/features/mcp-servers/cli-support.js'`; the new browser tests fail (no "Codex" checkbox).

- [ ] **Step 3: Write the catalogs**

```js
// web/lib/i18n/en/mcp-cli.js
export const mcpCliCopy = {
  legend: "Coding CLIs",
  hint: "AgentPier writes the server into each selected CLI's own configuration, for all of its accounts, so it also works when you start the CLI in a terminal. Running sessions see a change after a restart.",
  unsupported: {
    transport: "Codex does not support SSE servers.",
    cwd: "This CLI cannot start a command in a working directory.",
  },
  statuses: {
    written: "written",
    pending: "will be written at the next save or session start",
    conflict: "edited by hand in the CLI",
    "name-taken": "the name is already used by another entry in the CLI",
    error: "could not write",
  },
  reasons: {
    unreadable: "its configuration file cannot be read",
    duplicate: "the name appears in more than one of its configuration files",
    changed: "its configuration file kept changing; save again",
    transport: "it does not support this connection type",
    cwd: "it cannot use a working directory",
    invalid: "the stored arguments cannot be read",
  },
  statusLine: (cli, status) => `${cli}: ${status}`,
  errorWithReason: (reason) => `could not write: ${reason}`,
  overwrite: "Write AgentPier's version",
  overwriteFor: (cli, name) => `Write AgentPier's version of ${name} to ${cli}`,
  adoptChange: "Adopt the change",
  adoptChangeFor: (cli, name) => `Adopt the change to ${name} from ${cli}`,
  adopt: "Adopt",
  adoptFor: (cli, name) => `Adopt ${name} from ${cli}`,
  oauthConnected: (cli) => `Logged in in ${cli}`,
  oauthLogin: (cli, command) => `Log in once in ${cli}: run ${command}`,
  agentsUsing: (names) => `Agents: ${names}`,
  clisUsing: (names) => `CLIs: ${names}`,
  unused: "Not in use yet",
  restartNote: "Running sessions see changes after a restart.",
  foundTitle: "Found in the CLIs",
  foundHint:
    "Entries you added to a CLI yourself. AgentPier leaves them untouched until you adopt them. Values are never shown.",
  foundNone: "Nothing else found in the CLIs.",
  foundIn: (clis) => `in ${clis}`,
  valueNames: (names) => `Values: ${names}`,
  proposedName: "Name in AgentPier",
  adoptNamed: (name) => `Adopt ${name}`,
  adoptAll: "Adopt all",
  notAdoptable: {
    "unsupported-fields": "Uses settings AgentPier does not manage; it stays in the CLI.",
    invalid: "Cannot be read; it stays in the CLI.",
    duplicate: "Appears in more than one configuration file; it stays in the CLI.",
  },
  adoptFailed: (name, error) => `${name}: ${error}`,
  extensionsMoved:
    "MCP servers are managed centrally under Accounts → MCP servers. Choose there which coding CLIs get a server; AgentPier writes it into this CLI's configuration.",
  openCentralList: "Open MCP servers",
  stdioCliTitle: "Give coding CLIs a local command?",
  stdioCliWarning:
    "A stdio server runs this command with your user rights. Every session of the selected CLIs starts it, also when you start the CLI in a terminal. Only add commands you trust.",
  stdioCliConfirm: "Confirm and save",
  cliSaveFailed: (error) =>
    `The server was saved, but its CLIs could not be updated: ${error}`,
};
```

```js
// web/lib/i18n/de/mcp-cli.js
export const mcpCliCopy = {
  legend: "Coding-CLIs",
  hint: "AgentPier trägt den Server in die eigene Konfiguration jeder gewählten CLI ein, für alle ihre Accounts. So funktioniert er auch, wenn du die CLI im Terminal startest. Laufende Sitzungen sehen eine Änderung nach einem Neustart.",
  unsupported: {
    transport: "Codex unterstützt keine SSE-Server.",
    cwd: "Diese CLI kann einen Befehl nicht in einem Arbeitsverzeichnis starten.",
  },
  statuses: {
    written: "eingetragen",
    pending: "wird beim nächsten Speichern oder Sitzungsstart eingetragen",
    conflict: "in der CLI von Hand geändert",
    "name-taken": "der Name ist in der CLI schon von einem anderen Eintrag belegt",
    error: "konnte nicht eingetragen werden",
  },
  reasons: {
    unreadable: "ihre Konfigurationsdatei lässt sich nicht lesen",
    duplicate: "der Name steht in mehr als einer ihrer Konfigurationsdateien",
    changed: "ihre Konfigurationsdatei änderte sich laufend; bitte erneut speichern",
    transport: "sie unterstützt diese Verbindungsart nicht",
    cwd: "sie kann kein Arbeitsverzeichnis verwenden",
    invalid: "die gespeicherten Argumente lassen sich nicht lesen",
  },
  statusLine: (cli, status) => `${cli}: ${status}`,
  errorWithReason: (reason) => `konnte nicht eingetragen werden: ${reason}`,
  overwrite: "AgentPiers Version schreiben",
  overwriteFor: (cli, name) => `AgentPiers Version von ${name} in ${cli} schreiben`,
  adoptChange: "Änderung übernehmen",
  adoptChangeFor: (cli, name) => `Änderung an ${name} aus ${cli} übernehmen`,
  adopt: "Übernehmen",
  adoptFor: (cli, name) => `${name} aus ${cli} übernehmen`,
  oauthConnected: (cli) => `In ${cli} angemeldet`,
  oauthLogin: (cli, command) => `Einmal in ${cli} anmelden: ${command} ausführen`,
  agentsUsing: (names) => `Agenten: ${names}`,
  clisUsing: (names) => `CLIs: ${names}`,
  unused: "Noch nicht in Verwendung",
  restartNote: "Laufende Sitzungen sehen Änderungen nach einem Neustart.",
  foundTitle: "In den CLIs gefunden",
  foundHint:
    "Einträge, die du selbst in einer CLI angelegt hast. AgentPier lässt sie unverändert, bis du sie übernimmst. Werte werden nie angezeigt.",
  foundNone: "Sonst nichts in den CLIs gefunden.",
  foundIn: (clis) => `in ${clis}`,
  valueNames: (names) => `Werte: ${names}`,
  proposedName: "Name in AgentPier",
  adoptNamed: (name) => `${name} übernehmen`,
  adoptAll: "Alle übernehmen",
  notAdoptable: {
    "unsupported-fields":
      "Nutzt Einstellungen, die AgentPier nicht verwaltet; bleibt in der CLI.",
    invalid: "Lässt sich nicht lesen; bleibt in der CLI.",
    duplicate: "Steht in mehr als einer Konfigurationsdatei; bleibt in der CLI.",
  },
  adoptFailed: (name, error) => `${name}: ${error}`,
  extensionsMoved:
    "MCP-Server werden zentral unter Accounts → MCP-Server verwaltet. Dort wählst du, welche Coding-CLIs einen Server bekommen; AgentPier trägt ihn in die Konfiguration dieser CLI ein.",
  openCentralList: "MCP-Server öffnen",
  stdioCliTitle: "Coding-CLIs einen lokalen Befehl geben?",
  stdioCliWarning:
    "Ein stdio-Server führt diesen Befehl mit deinen Rechten aus. Jede Sitzung der gewählten CLIs startet ihn, auch wenn du die CLI im Terminal startest. Füge nur Befehle hinzu, denen du vertraust.",
  stdioCliConfirm: "Bestätigen und speichern",
  cliSaveFailed: (error) =>
    `Der Server wurde gespeichert, aber seine CLIs ließen sich nicht aktualisieren: ${error}`,
};
```

```js
// web/lib/i18n/messages/mcp-cli.js
import * as de from "../de/mcp-cli.js";
import * as en from "../en/mcp-cli.js";
import { localizedCopy } from "../index.js";
export const mcpCliCopy = localizedCopy(de.mcpCliCopy, en.mcpCliCopy);
```

Change `description` in `web/lib/i18n/en/mcp-servers.js` to `"Central MCP servers for agents and coding CLIs. Header and environment values are stored on this computer and are never shown again."` and in `web/lib/i18n/de/mcp-servers.js` to `"Zentrale MCP-Server für Agenten und Coding-CLIs. Header- und Umgebungswerte liegen auf diesem Computer und werden nie wieder angezeigt."`.

- [ ] **Step 4: Write the browser helpers**

```js
// web/features/mcp-servers/cli-support.js
// Mirrors cliSupport in server/features/mcp-servers/cli-native.js so the form can
// explain a disabled CLI; the server decides (400 MCP_CLI_*_UNSUPPORTED).
export const clis = ["claude", "codex", "opencode"];
export function cliSupport(cli, server) {
  if (cli === "codex" && server.transport === "sse")
    return { supported: false, reason: "transport" };
  if (cli !== "codex" && server.transport === "stdio" && server.cwd)
    return { supported: false, reason: "cwd" };
  return { supported: true };
}
```

```js
// web/features/mcp-servers/cli-api.js
import api from "../../lib/api.js";

const id = (value) => encodeURIComponent(value);
const confirm = (confirmStdio) => (confirmStdio ? { confirmStdio: true } : {});

/** Central MCP servers in the coding CLIs (server/http/routes/mcp-cli.js). */
export const cliApi = {
  setClis: (serverId, clis, confirmStdio = false) =>
    api(`/mcp-servers/${id(serverId)}/clis`, "PUT", { clis, ...confirm(confirmStdio) }),
  resolve: (serverId, cli, choice, confirmStdio = false) =>
    api(`/mcp-servers/${id(serverId)}/clis/${id(cli)}/resolve`, "POST", {
      choice,
      ...confirm(confirmStdio),
    }),
  finds: () => api("/mcp-servers/cli-finds"),
  adopt: (body) => api("/mcp-servers/cli-finds/adopt", "POST", body),
};
```

```css
/* web/features/mcp-servers/mcp-cli.css */
.mcp-cli-choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.mcp-cli-choices legend {
  padding: 0;
  font-weight: 600;
}
.mcp-cli-choice label {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mcp-cli-choice input[type="checkbox"] {
  flex: none;
  width: 18px;
  height: 18px;
}
.mcp-cli-choice small {
  display: block;
  margin-left: 28px;
}
.mcp-cli-status ul {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.mcp-cli-status li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  overflow-wrap: anywhere;
}
.mcp-cli-finds {
  margin-top: 20px;
}
.mcp-cli-finds h3 {
  margin: 0 0 4px;
}
.mcp-cli-finds label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.mcp-cli-finds input {
  max-width: 100%;
}
```

- [ ] **Step 5: Write the CLI choices and the status**

```jsx
// web/features/mcp-servers/McpCliChoices.jsx
import React from "react";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { names } from "../../lib/providers.js";
import { cliSupport, clis } from "./cli-support.js";

/** The form's Coding CLIs: one checkbox each, disabled with the reason it cannot run the server. */
export default function McpCliChoices({ id, target, selected, onChange }) {
  const toggle = (cli, on) =>
    onChange(
      on
        ? [...selected.filter((item) => item !== cli), cli]
        : selected.filter((item) => item !== cli),
    );
  return (
    <fieldset className="mcp-cli-choices" aria-describedby={`${id}-hint`}>
      <legend>{copy.legend}</legend>
      <p className="mcp-hint" id={`${id}-hint`}>
        {copy.hint}
      </p>
      {clis.map((cli) => {
        const support = cliSupport(cli, target);
        const reason = `${id}-${cli}-reason`;
        return (
          <div key={cli} className="mcp-cli-choice">
            <label>
              <input
                type="checkbox"
                checked={support.supported && selected.includes(cli)}
                disabled={!support.supported}
                aria-describedby={support.supported ? undefined : reason}
                onChange={(event) => toggle(cli, event.target.checked)}
              />
              <span>{names[cli]}</span>
            </label>
            {!support.supported && (
              <small id={reason} className="mcp-hint">
                {copy.unsupported[support.reason]}
              </small>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
```

```jsx
// web/features/mcp-servers/McpCliStatus.jsx
import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { names } from "../../lib/providers.js";
import { cliApi } from "./cli-api.js";
import StdioConfirmation from "./StdioConfirmation.jsx";
import { stdioConfirmationRequired } from "./stdio-confirmation.js";

const statusText = (state) =>
  state.status === "error"
    ? copy.errorWithReason(copy.reasons[state.reason] || copy.reasons.unreadable)
    : copy.statuses[state.status] || copy.statuses.pending;
const oauthText = (cli, oauth) =>
  oauth.state === "connected"
    ? copy.oauthConnected(names[cli])
    : copy.oauthLogin(names[cli], oauth.command);

/** Per bound CLI: whether AgentPier's entry is there, and the owner's choices when it is not. */
export default function McpCliStatus({ server, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(null);
  if (!server.clis?.length) return null;
  async function resolve(cli, choice, confirmStdio = false) {
    setBusy(true);
    setError("");
    try {
      await cliApi.resolve(server.id, cli, choice, confirmStdio);
      setConfirm(null);
      await onChanged();
    } catch (e) {
      if (stdioConfirmationRequired(e)) setConfirm({ cli, choice });
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const button = (cli, choice, label, aria) => (
    <button
      type="button"
      className="button secondary compact"
      disabled={busy}
      aria-label={aria}
      onClick={() => resolve(cli, choice)}
    >
      {label}
    </button>
  );
  return (
    <div className="mcp-cli-status">
      <ul>
        {server.clis.map((cli) => {
          const state = server.cliStatus?.[cli] || { status: "pending" };
          return (
            <li key={cli}>
              <span>{copy.statusLine(names[cli], statusText(state))}</span>
              {state.oauth && (
                <span className="mcp-hint">{oauthText(cli, state.oauth)}</span>
              )}
              {state.status === "conflict" && (
                <span className="mcp-actions">
                  {button(
                    cli,
                    "overwrite",
                    copy.overwrite,
                    copy.overwriteFor(names[cli], server.name),
                  )}
                  {button(
                    cli,
                    "adopt",
                    copy.adoptChange,
                    copy.adoptChangeFor(names[cli], server.name),
                  )}
                </span>
              )}
              {state.status === "name-taken" &&
                button(cli, "adopt", copy.adopt, copy.adoptFor(names[cli], server.name))}
            </li>
          );
        })}
      </ul>
      <ErrorMessage error={error} />
      {confirm && (
        <StdioConfirmation
          cli
          busy={busy}
          onConfirm={() => resolve(confirm.cli, confirm.choice, true)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
```

In `web/features/mcp-servers/StdioConfirmation.jsx` add the prop `cli = false` and import `{ mcpCliCopy as cliCopy }` from `../../lib/i18n/messages/mcp-cli.js`; keep PR #229's focus handling and replace the three `binding ? … : …` text choices with:

```jsx
const title = cli
  ? cliCopy.stdioCliTitle
  : binding
    ? copy.stdioBindingTitle
    : copy.stdioWarningTitle;
const warning = cli
  ? cliCopy.stdioCliWarning
  : binding
    ? copy.stdioBindingWarning
    : copy.stdioWarning;
const confirmLabel = cli
  ? cliCopy.stdioCliConfirm
  : binding
    ? copy.stdioBindingConfirm
    : copy.stdioConfirm;
```

using `title` for `aria-label` and `<strong>`, `warning` for `<p>`, `confirmLabel` for the primary button.

- [ ] **Step 6: Put them into the form and the list**

In `web/features/mcp-servers/McpServerForm.jsx`:

- add the imports `import { cliApi } from "./cli-api.js";`, `import { cliSupport } from "./cli-support.js";`, `import McpCliChoices from "./McpCliChoices.jsx";`;
- add state `const [clis, setClis] = useState(() => server?.clis || []);` and `const [cliConfirm, setCliConfirm] = useState(false);`, and `setCliConfirm(false);` as the first line of the `set` helper;
- after `const oauth = …;` add

```js
// The CLIs the server goes to: unsupported ones fall away as the draft changes.
const target = { transport: draft.transport, cwd: draft.cwd.trim() };
const wanted = clis.filter((cli) => cliSupport(cli, target).supported);
const before = server?.clis || [];
const added = wanted.filter((cli) => !before.includes(cli));
const clisChanged = added.length > 0 || wanted.length !== before.length;
```

- replace `submit` with

```js
async function submit(confirmStdio = false, confirmSwitch = false) {
  if (dropsStoredHeaders(draft, server) && !confirmSwitch) {
    setSwitching(true);
    return;
  }
  setSwitching(false);
  // A CLI gets a local command only after the owner confirmed it; nothing is saved before.
  if (stdio && added.length && !confirmStdio) {
    setCliConfirm(true);
    return;
  }
  setCliConfirm(false);
  setBusy(true);
  setError("");
  try {
    const body = {
      ...requestBody(draft, server),
      ...(confirmStdio ? { confirmStdio } : {}),
    };
    const saved = server
      ? await assistantApi.updateMcpServer(server.id, body)
      : await assistantApi.createMcpServer(body);
    let cliError = "";
    if (clisChanged)
      try {
        await cliApi.setClis(saved.id, wanted, confirmStdio);
      } catch (e) {
        cliError = e.message;
      }
    await onSaved(cliError ? { ...saved, cliError } : saved);
  } catch (e) {
    if (stdioConfirmationRequired(e)) setConfirming(true);
    else setError(e.message);
  } finally {
    setBusy(false);
  }
}
```

- above `<p className="mcp-hint">{copy.secretNote}</p>` insert

```jsx
<McpCliChoices id={`${formId}-clis`} target={target} selected={clis} onChange={setClis} />
```

- next to the existing `{confirming && (<StdioConfirmation … />)}` insert

```jsx
{
  cliConfirm && (
    <StdioConfirmation
      cli
      busy={busy}
      onConfirm={() => submit(true)}
      onCancel={() => setCliConfirm(false)}
    />
  );
}
```

In `web/features/mcp-servers/McpServersSettings.jsx`:

- add the imports `import { mcpCliCopy as cliCopy } from "../../lib/i18n/messages/mcp-cli.js";`, `import { names as cliNames } from "../../lib/providers.js";`, `import McpCliStatus from "./McpCliStatus.jsx";`, `import "./mcp-cli.css";`;
- below the `names` helper add

```js
/** "Agents: Home, Lead · CLIs: Claude Code, Codex": who uses a server, by name. */
function usersText(server) {
  const parts = [];
  if (server.users?.agents?.length)
    parts.push(cliCopy.agentsUsing(server.users.agents.join(", ")));
  if (server.users?.clis?.length)
    parts.push(
      cliCopy.clisUsing(server.users.clis.map((cli) => cliNames[cli]).join(", ")),
    );
  return parts.length ? parts.join(" · ") : cliCopy.unused;
}
```

- extend `savedNotice` with `saved?.cliError ? cliCopy.cliSaveFailed(saved.cliError) : "",` as a third entry;
- after `<p className="mcp-hint">{copy.description}</p>` add `<p className="mcp-hint">{cliCopy.restartNote}</p>`;
- after `<ServerDetails server={server} />` add

```jsx
            <p className="mcp-hint">{usersText(server)}</p>
            <McpCliStatus server={server} onChanged={load} />
```

- [ ] **Step 7: Run the tests**

Run: `node --test tests/unit/mcp-cli-support.test.js tests/unit/i18n-catalogs.test.js tests/unit/mcp-server-draft.test.js && npm run build && npx playwright test tests/browser/mcp-cli-bindings.spec.js tests/browser/agent-mcp-servers.spec.js tests/browser/mcp-oauth.spec.js --project=chromium`
Expected: PASS. Then exercise the form in English once by hand (`npm run build && npm start` on a disposable `--data-dir`, Accounts → MCP servers) and check the phone width (390 px): no horizontal scroll.

- [ ] **Step 8: Check and commit**

Run: `npm run lint && npm run format:check && npm run check:structure`

```bash
git add web/lib/i18n/de/mcp-cli.js web/lib/i18n/en/mcp-cli.js web/lib/i18n/messages/mcp-cli.js web/lib/i18n/de/mcp-servers.js web/lib/i18n/en/mcp-servers.js web/features/mcp-servers/cli-api.js web/features/mcp-servers/cli-support.js web/features/mcp-servers/McpCliChoices.jsx web/features/mcp-servers/McpCliStatus.jsx web/features/mcp-servers/mcp-cli.css web/features/mcp-servers/McpServerForm.jsx web/features/mcp-servers/McpServersSettings.jsx web/features/mcp-servers/StdioConfirmation.jsx tests/unit/mcp-cli-support.test.js tests/browser/mcp-cli-bindings.spec.js
git commit -m "feat: choose coding CLIs for MCP servers and resolve their conflicts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Found in the CLIs, and the CLI extensions page points to the central list

Adds the **Found in the CLIs** section (Adopt, Adopt all, editable name proposals, names only) and replaces the MCP part of the CLI extensions page with a pointer to Accounts → MCP servers. **Ruling:** the extension MCP write path (`POST`/`DELETE /api/accounts/:id/extensions/mcp`, `ExtensionsStore.addMcp`/`removeMcp`, `cleanMcp`, `McpForm.jsx`) is removed, so there is exactly one place that writes MCP entries; the guarantees its tests pinned (unrelated settings and comments kept, malformed or ambiguous files never rewritten, symlinks refused, OpenCode duplicates left alone) are pinned for the reconciler in Task 5. Existing native entries keep working: they show up as finds.

**Files:**

- Create: `web/features/mcp-servers/McpCliFinds.jsx`
- Modify: `web/features/mcp-servers/McpServersSettings.jsx` (finds section, `focus`)
- Modify: `web/app/routes.js:66-71,~164` (`/accounts?section=mcp-servers`), `web/app/App.jsx:~278`, `web/features/accounts/AccountsPage.jsx`
- Modify: `web/features/extensions/ExtensionsPage.jsx:~80`, `web/features/extensions/ExtensionWorkspace.jsx`, `web/features/extensions/McpTab.jsx`
- Delete: `web/features/extensions/McpForm.jsx`
- Modify: `server/http/routes/extensions.js:12-18`, `server/features/extensions/extension-store.js:8-24,234-272`, `server/features/extensions/mcp-config.js:60-96`
- Test: `tests/browser/mcp-cli-bindings.spec.js`, `tests/browser/extensions.spec.js`, `tests/unit/routes.test.js`, `tests/integration/extensions.test.js`

**Interfaces:**

- Consumes: `GET /api/mcp-servers/cli-finds`, `POST /api/mcp-servers/cli-finds/adopt` (Task 8), `cliApi`, `mcpCliCopy` (Task 9).
- Produces: `McpCliFinds({ refresh, onAdopted })`; route `{ view: "accounts", section: "mcp-servers" }` ↔ `/accounts?section=mcp-servers`; `McpServersSettings({ oauthResult, agentsEnabled, focus })`; `ExtensionWorkspace({ …, onNavigate })`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/routes.test.js`:

```js
test("the central MCP list has its own Accounts address", () => {
  const route = read("/accounts?section=mcp-servers");
  assert.deepEqual(route, { view: "accounts", section: "mcp-servers" });
  assert.equal(path(route), "/accounts?section=mcp-servers");
  assert.deepEqual(read("/accounts?section=other"), { view: "accounts" });
  assert.equal(path({ view: "accounts" }), "/accounts");
});
```

Append to `tests/browser/mcp-cli-bindings.spec.js`:

```js
const finds = [
  {
    key: "k1",
    name: "docs",
    clis: ["claude", "codex"],
    adoptable: true,
    transport: "http",
    auth: "headers",
    url: "https://docs.example.test/mcp",
    headerNames: ["Authorization"],
    envNames: [],
  },
  {
    key: "k2",
    name: "my.tool",
    proposedName: "my-tool",
    clis: ["opencode"],
    adoptable: true,
    transport: "stdio",
    auth: "headers",
    command: "/usr/bin/true",
    headerNames: [],
    envNames: ["TOKEN"],
  },
  {
    key: "k3",
    name: "slow",
    clis: ["codex"],
    adoptable: false,
    reason: "unsupported-fields",
  },
];

test("entries found in the CLIs are adopted one by one or all at once, names only", async ({
  page,
}) => {
  const state = await setup(page, { finds });
  state.handle = async ({ route, path, body }) => {
    if (path !== "/api/mcp-servers/cli-finds/adopt") return false;
    const keys = body.all ? ["k1", "k2"] : body.keys;
    state.finds = state.finds.filter((find) => !keys.includes(find.key));
    return route.fulfill({
      json: {
        adopted: keys.map((key) => header({ id: key, name: body.names[key] })),
        failed: [],
      },
    });
  };
  await page.goto(baseURL + "/accounts");
  const found = page.getByRole("region", { name: "Found in the CLIs" });
  await expect(found.getByText("in Claude Code, Codex")).toBeVisible();
  await expect(found.getByText("Values: Authorization")).toBeVisible();
  await expect(
    found.getByText("Uses settings AgentPier does not manage; it stays in the CLI."),
  ).toBeVisible();
  await expect(found.getByLabel("Name in AgentPier")).toHaveValue("my-tool");
  await found.getByLabel("Name in AgentPier").fill("tool");
  await found.getByRole("button", { name: "Adopt my.tool" }).click();
  await expect(found.getByText("my.tool", { exact: true })).toHaveCount(0);
  expect(state.requests.find((r) => r.path.endsWith("/adopt")).body).toEqual({
    keys: ["k2"],
    names: { k2: "tool" },
  });
  await expect(found.getByRole("button", { name: "Adopt all" })).toHaveCount(0);
  state.finds = finds;
  await page.reload();
  await page
    .getByRole("region", { name: "Found in the CLIs" })
    .getByRole("button", { name: "Adopt all" })
    .click();
  expect(state.requests.filter((r) => r.path.endsWith("/adopt")).at(-1).body).toEqual({
    all: true,
    names: { k1: "docs", k2: "my-tool" },
  });
});

test("a found entry that fails to adopt is named; German copy", async ({ page }) => {
  const state = await setup(page, { language: "de", finds: [finds[1]] });
  state.handle = async ({ route, path }) =>
    path.endsWith("/adopt")
      ? route.fulfill({
          json: {
            adopted: [],
            failed: [{ key: "k2", name: "my.tool", error: "Befehl nicht gefunden." }],
          },
        })
      : false;
  await page.goto(baseURL + "/accounts");
  const found = page.getByRole("region", { name: "In den CLIs gefunden" });
  await found.getByRole("button", { name: "my.tool übernehmen" }).click();
  await expect(found.getByRole("status")).toHaveText("my.tool: Befehl nicht gefunden.");
});
```

In `tests/browser/extensions.spec.js` delete the tests "MCP configuration is account-scoped, preserves secrets only in request and can be removed" and "failed MCP writes preserve the draft and never submit twice while pending", and add:

```js
test("the MCP tab points to the central MCP server list", async ({ page }) => {
  const { writes } = await fixture(page);
  await open(page);
  await expect(
    page.getByText(/MCP-Server werden zentral unter Accounts → MCP-Server verwaltet/),
  ).toBeVisible();
  await page.getByRole("button", { name: "MCP-Server öffnen", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts\?section=mcp-servers$/);
  expect(writes).toHaveLength(0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/routes.test.js; npm run build && npx playwright test tests/browser/mcp-cli-bindings.spec.js tests/browser/extensions.spec.js --project=chromium`
Expected: the route test fails (`section` is dropped); the finds and extension tests fail (no "Found in the CLIs" region, no "MCP-Server öffnen" button).

- [ ] **Step 3: Write the finds section**

```jsx
// web/features/mcp-servers/McpCliFinds.jsx
import React, { useCallback, useEffect, useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { mcpServerCopy as serverCopy } from "../../lib/i18n/messages/mcp-servers.js";
import { names } from "../../lib/providers.js";
import { cliApi } from "./cli-api.js";

/**
 * Entries the owner added to a CLI outside AgentPier, offered for adoption; never
 * adopted on their own. Shows names only. `refresh` changes whenever the list reloads.
 */
export default function McpCliFinds({ refresh, onAdopted }) {
  const titleId = useId();
  const [finds, setFinds] = useState(null);
  const [renamed, setRenamed] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      setFinds((await cliApi.finds()).finds);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, refresh]);
  const nameOf = (find) => renamed[find.key] ?? find.proposedName ?? find.name;
  async function adopt(body) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await cliApi.adopt(body);
      setNotice(
        result.failed.map((item) => copy.adoptFailed(item.name, item.error)).join(" "),
      );
      await load();
      await onAdopted();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!finds) return <ErrorMessage error={error} />;
  const adoptable = finds.filter((find) => find.adoptable);
  return (
    <section className="mcp-cli-finds" aria-labelledby={titleId}>
      <h3 id={titleId}>{copy.foundTitle}</h3>
      <p className="mcp-hint">{copy.foundHint}</p>
      <ErrorMessage error={error} />
      {notice && (
        <p role="status" className="mcp-hint">
          {notice}
        </p>
      )}
      {!finds.length && <p className="mcp-hint">{copy.foundNone}</p>}
      <ul className="mcp-list">
        {finds.map((find) => (
          <li key={find.key} className="mcp-item">
            <div className="mcp-item-head">
              <strong>{find.name}</strong>
              {find.transport && (
                <span className="mcp-badge">{serverCopy.transports[find.transport]}</span>
              )}
              <span className="mcp-hint">
                {copy.foundIn(find.clis.map((cli) => names[cli]).join(", "))}
              </span>
            </div>
            {(find.url || find.command) && <code>{find.url || find.command}</code>}
            {[...(find.headerNames || []), ...(find.envNames || [])].length > 0 && (
              <p className="mcp-hint">
                {copy.valueNames(
                  [...(find.headerNames || []), ...(find.envNames || [])].join(", "),
                )}
              </p>
            )}
            {find.adoptable ? (
              <div className="mcp-actions">
                {find.proposedName && (
                  <label>
                    {copy.proposedName}
                    <input
                      value={nameOf(find)}
                      maxLength={30}
                      autoCapitalize="none"
                      spellCheck={false}
                      onChange={(event) =>
                        setRenamed((current) => ({
                          ...current,
                          [find.key]: event.target.value,
                        }))
                      }
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  aria-label={copy.adoptNamed(find.name)}
                  onClick={() =>
                    adopt({ keys: [find.key], names: { [find.key]: nameOf(find) } })
                  }
                >
                  {copy.adopt}
                </button>
              </div>
            ) : (
              <p className="mcp-hint">
                {copy.notAdoptable[find.reason] || copy.notAdoptable.invalid}
              </p>
            )}
          </li>
        ))}
      </ul>
      {adoptable.length > 1 && (
        <div className="mcp-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() =>
              adopt({
                all: true,
                names: Object.fromEntries(
                  adoptable.map((find) => [find.key, nameOf(find)]),
                ),
              })
            }
          >
            {copy.adoptAll}
          </button>
        </div>
      )}
    </section>
  );
}
```

In `web/features/mcp-servers/McpServersSettings.jsx`:

- import `McpCliFinds from "./McpCliFinds.jsx"`;
- change the signature to `export default function McpServersSettings({ oauthResult, agentsEnabled = true, focus = false })`;
- add `const [generation, setGeneration] = useState(0);` and in `load`, after `setServers(…)`, call `setGeneration((value) => value + 1);`;
- below the `oauthResult` scroll effect add

```js
// Opened from the CLI extensions page: the list belongs in view.
useEffect(() => {
  if (focus) section.current?.scrollIntoView?.({ block: "start" });
}, [focus]);
```

- after the "Add MCP server" `<div className="mcp-actions">…</div>` insert `<McpCliFinds refresh={generation} onAdopted={load} />`.

- [ ] **Step 4: Give the list an address**

In `web/app/routes.js` replace the `/accounts` branch of `readRoute` with

```js
if (pathname === "/accounts")
  return {
    view: "accounts",
    // Opened from the CLI extensions page: scrolls to the central MCP list.
    ...(new URLSearchParams(location.search).get("section") === "mcp-servers"
      ? { section: "mcp-servers" }
      : {}),
    // An MCP OAuth login's result; the address drops it (see routePath).
    ...readMcpOAuthResult(location.search),
  };
```

and in `routePath`, before the final `return`, add

```js
if (route.view === "accounts")
  return route.section === "mcp-servers" ? "/accounts?section=mcp-servers" : "/accounts";
```

In `web/app/App.jsx` pass `mcpSection: route.section,` next to `mcpOAuth: route.mcpOAuth,`; in `web/features/accounts/AccountsPage.jsx` accept `mcpSection` and render `<McpServersSettings oauthResult={mcpOAuth} agentsEnabled={!!agentsEnabled} focus={mcpSection === "mcp-servers"} />`.

- [ ] **Step 5: Point the CLI extensions page to the central list**

Replace `web/features/extensions/McpTab.jsx` with:

```jsx
import React from "react";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { ExtensionHint } from "./ExtensionTable.jsx";

/** MCP servers are managed in the central list (Accounts → MCP servers). */
export default function McpTab() {
  return (
    <ExtensionHint>
      <p>{copy.extensionsMoved}</p>
    </ExtensionHint>
  );
}
```

In `web/features/extensions/ExtensionWorkspace.jsx`:

- accept `onNavigate` in the props; remove `mcpFormCopy` from the `extensions.js` import and the `McpForm` import; add `import { mcpCliCopy } from "../../lib/i18n/messages/mcp-cli.js";`;
- tab entry: `{ id: "mcp", label: hub.tabMcp },` (no count);
- in `openPanel`: `if (kind === "skill") ext.setError("");`;
- primary action for the MCP tab:

```js
    mcp: {
      label: mcpCliCopy.openCentralList,
      run: () => onNavigate({ view: "accounts", section: "mcp-servers" }),
    },
```

- `const extPanel = panel === "skill";`, `{tab === "mcp" && <McpTab />}`, and delete the `{panel === "mcp" && (<McpForm … />)}` block.

In `web/features/extensions/ExtensionsPage.jsx` pass `onNavigate={onNavigate}` to `<ExtensionWorkspace>`. Delete `web/features/extensions/McpForm.jsx`.

- [ ] **Step 6: Remove the extension MCP write path**

- `server/http/routes/extensions.js`: delete the `router.post("/accounts/:id/extensions/mcp", …)` and `router.delete("/accounts/:id/extensions/mcp/:name", …)` handlers.
- `server/features/extensions/extension-store.js`: delete `addMcp` and `removeMcp` and reduce the `mcp-config.js` import to `{ record, publicMcp, safePath, readConfig }`.
- `server/features/extensions/mcp-config.js`: delete `cleanMcp` (lines 60-96), then run `grep -rn "cleanMcp\|addMcp\|removeMcp" server web tests` and expect no match outside `tests/integration/extensions.test.js`.
- `tests/integration/extensions.test.js`: delete the tests "`${tool}` MCP config uses the selected native profile and preserves unrelated settings" (the `for` loop at line 43), "MCP remote headers are native, redacted, and invalid config is never overwritten", "OpenCode removal refuses duplicate definitions rather than reactivating a shadowed server", "Codex MCP editing retains unrelated comments and dotted quoted configuration" and "ambiguous JSONC keys and non-JSON Claude config are rejected without rewriting"; in "managed symlinked config roots are rejected before profile initialization can modify their target" replace the `store.addMcp(account.id, { … })` call inside `assert.throws` with `store.list(account.id)`; remove imports that are now unused (`parseToml`, `parseJsonc`).

- [ ] **Step 7: Run the tests**

Run: `node --test tests/unit/routes.test.js tests/integration/extensions.test.js tests/integration/cli-mcp-reconciler.test.js tests/unit/i18n-catalogs.test.js && npm run build && npx playwright test tests/browser/mcp-cli-bindings.spec.js tests/browser/extensions.spec.js --project=chromium`
Expected: PASS. Check the Found section at 390 px width: no horizontal scroll.

- [ ] **Step 8: Check and commit**

Run: `npm run lint && npm run format:check && npm run check:structure`

```bash
git add -A web/features/mcp-servers/McpCliFinds.jsx web/features/mcp-servers/McpServersSettings.jsx web/app/routes.js web/app/App.jsx web/features/accounts/AccountsPage.jsx web/features/extensions server/http/routes/extensions.js server/features/extensions/extension-store.js server/features/extensions/mcp-config.js tests/unit/routes.test.js tests/browser/mcp-cli-bindings.spec.js tests/browser/extensions.spec.js tests/integration/extensions.test.js
git commit -m "feat: adopt found CLI MCP entries and manage MCP servers in one list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Operating guides, full check and cleanup

Documents the behaviour for operators, runs the complete check, and removes the temporary spec and plan (AGENTS.md cleanup rule) in the final commit before the pull request.

**Files:**

- Modify: `docs/mcp.md` (new section at the end)
- Modify: `docs/shared-cli-extensions.md` (after the native configuration table; "Migration and subsequent edits")
- Modify: `docs/sandbox.md` ("The grant model"; "Known limitations")
- Delete: `docs/superpowers/specs/2026-10-12-mcp-cli-bindings-design.md`, `docs/superpowers/plans/2026-10-12-mcp-cli-bindings.md`

**Interfaces:**

- Consumes: everything above; `docs/cli-mcp-qualification.md` (Task 1).
- Produces: operator documentation; a clean tree for the pull request.

- [ ] **Step 1: Document the central list in the CLIs**

Append to `docs/mcp.md`:

```markdown
## Central MCP servers in the coding CLIs

Accounts → **MCP servers** is the one place for the MCP servers the owner uses. A server
can be given to agents and to the coding CLIs Claude Code, Codex and OpenCode (**Coding
CLIs** in the server form). A server bound to a CLI is written into that CLI's own
configuration — `~/.claude.json` `mcpServers`, `~/.codex/config.toml` `mcp_servers`,
`~/.config/opencode/opencode.json(c)` `mcp` — so it also works when the CLI is started
in a terminal, and the shared CLI profile carries it to every AgentPier account of that
CLI. AgentPier writes at every save and before every session start; running sessions see
a change after a restart. The list, the CLI bindings and the finds work with or without
agents; agent OAuth logins need agents.

- **Support.** Claude Code: stdio, HTTP, SSE. Codex: stdio, HTTP (no SSE). OpenCode:
  stdio and HTTP or SSE (`remote`). Only Codex starts a stdio command in a working
  directory. Unsupported combinations are disabled with a reason in the form and refused
  by the API (`400 MCP_CLI_TRANSPORT_UNSUPPORTED`, `400 MCP_CLI_CWD_UNSUPPORTED`).
  [cli-mcp-qualification.md](cli-mcp-qualification.md) records the native forms and how
  they were verified.
- **Ownership.** AgentPier records each entry it wrote by name and hash in
  `<data>/mcp-servers/servers.sqlite`; native files get no marker. An entry is
  AgentPier's while it still matches that hash. Entries anyone else wrote are never
  modified or removed; unbinding or deleting removes only an unchanged AgentPier entry.
- **Status per CLI.** _written_; _will be written_ (restored at the next save or session
  start); _edited by hand in the CLI_, with **Write AgentPier's version** or **Adopt the
  change** (the edit becomes the central definition for every bound CLI and agent);
  _name taken_ by another entry, with **Adopt** (that entry becomes the server's);
  _could not write_, with the reason: an unreadable or symlinked file, a name defined in
  two OpenCode files, or a file that kept changing during three attempts. Another CLI or
  the agents are never held up by one CLI's file.
- **Found in the CLIs.** Entries added to a CLI outside AgentPier are listed with
  **Adopt** and **Adopt all**, never adopted on their own. Identical entries from several
  CLIs become one server bound to each; the same name with different content stays
  separate. Invalid or taken names get a proposal. Adopting replaces the old entry with
  AgentPier's only while it is unchanged since it was shown. Entries using settings
  AgentPier does not manage (for example Codex `startup_timeout_sec` or a disabled
  entry) stay in the CLI.
- **Secrets.** Header and environment values are stored by AgentPier and written in
  plain text into the CLI files with mode 0600, because the CLIs read them there. They
  never appear in API responses, logs or the audit trail (names only).
- **OAuth.** AgentPier writes each CLI's OAuth form without static headers. Codex reports
  its login state (`codex mcp list --json`); for Claude Code (`/mcp` in a session) and
  OpenCode (`opencode mcp auth <name>`) AgentPier shows the login command. Logins
  brokered by AgentPier are a follow-up, only for the CLIs the qualification marks as
  working.
- **Audit.** Binding and unbinding CLIs, conflict choices and adoptions are recorded as
  `mcp.updated`/`mcp.created` with the CLIs, never with an entry or a value.
- The MCP tab of **Extensions** points here; MCP entries are no longer edited per CLI
  profile.
```

- [ ] **Step 2: Update the shared-extension and sandbox guides**

In `docs/shared-cli-extensions.md`, insert after the native configuration table's paragraph that starts "The server user's native profile is authoritative":

```markdown
MCP servers are managed centrally under Accounts → **MCP servers** ([mcp.md](mcp.md#central-mcp-servers-in-the-coding-clis)); the Extensions MCP tab links there. AgentPier writes servers bound to a CLI into that CLI's canonical native profile before each launch, ahead of the projection described below, so a managed account receives them in the same launch. Entries added natively are still shared and are offered for adoption in the central list.
```

and append to the paragraph that starts "Native CLI changes to shared configuration fields" the sentence: `AgentPier's own MCP writes go only to the canonical profile, so they never appear as drift of an account.`

In `docs/sandbox.md`, append to "The grant model" (before "### An example launch"):

```markdown
Central MCP servers bound to a coding CLI ([mcp.md](mcp.md#central-mcp-servers-in-the-coding-clis))
run inside that CLI's sandbox. For each bound stdio server
`server/features/mcp-servers/cli-grants.js` declares read access to its resolved
command, to the file that command links to, and to the interpreter its `#!` line names
(for `#!/usr/bin/env name` also `name` resolved on the session's PATH), and full access
to its working directory. Remote servers need no grant.
```

and append to "Known limitations" (after item 7):

```markdown
8. **MCP servers outside the central list.** Stdio servers the owner added to a CLI
   outside AgentPier get no grants until they are adopted. A bound command that loads
   more files while it runs (for example `npx` with its package cache) needs the
   operator's sandbox profile to allow them.
```

- [ ] **Step 3: Run the complete check**

Run: `npm run check && npx playwright test tests/browser/mcp-cli-bindings.spec.js tests/browser/extensions.spec.js tests/browser/agent-mcp-servers.spec.js tests/browser/mcp-oauth.spec.js tests/browser/mcp-settings.spec.js`
Expected: lint, format, structure, build and all Node suites pass; the browser specs pass in Chromium and WebKit. Then once: `AGENTPIER_CLI_MCP_CONTRACT=1 AGENTPIER_CLI_CONTRACT_DATA_DIR=<AgentPier data dir> node --test tests/integration/cli-mcp-contract.test.js` passes.

- [ ] **Step 4: Commit the guides**

```bash
git add docs/mcp.md docs/shared-cli-extensions.md docs/sandbox.md
git commit -m "docs: describe central MCP servers in the coding CLIs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Remove the temporary spec and plan**

```bash
git rm docs/superpowers/specs/2026-10-12-mcp-cli-bindings-design.md docs/superpowers/plans/2026-10-12-mcp-cli-bindings.md
git commit -m "chore: remove central MCP CLI binding working documents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Run: `git status --short`
Expected: clean. The branch is ready for a pull request (title and description in English; link AGENTPIER-38; screenshots of the form, the statuses and the Found section).

---

## Spec coverage

| Spec requirement                                                                    | Task       |
| ----------------------------------------------------------------------------------- | ---------- |
| `cli` target kind, ids `claude`/`codex`/`opencode`; `cli_entries` with hashes       | 4          |
| Managed / conflict / unmanaged; removal only while unchanged; names taken           | 5          |
| Secrets in native files (0600), never in logs, audit or responses                   | 5, 8       |
| Transport support pinned by a contract; `400 MCP_CLI_TRANSPORT_UNSUPPORTED`         | 1, 3, 7, 8 |
| `nativeMcp()` with SSE and OAuth forms                                              | 1, 3       |
| Name rule kept; proposals; adopt replaces the old entry only if unchanged           | 3, 6       |
| Write on every save and before every session start; restart note                    | 7, 9       |
| Shared profile carries entries to accounts; baselines never report drift            | 7          |
| nono grants for bound stdio servers (command, interpreter, cwd)                     | 7          |
| OAuth status per CLI or login command; brokering probe                              | 1, 8       |
| CLI extensions MCP section replaced by a link                                       | 10         |
| UI: users, Coding CLIs block with reasons, statuses, conflict choices, finds, de/en | 9, 10      |
| Errors: malformed file, compare-and-swap retry, crash order                         | 5          |
| Tests: fixtures for all CLIs, contracts in an isolated HOME, browser, audit         | 1–10       |
| Central list without agents (ruling)                                                | 2          |
| Docs and cleanup of plan and spec                                                   | 11         |
