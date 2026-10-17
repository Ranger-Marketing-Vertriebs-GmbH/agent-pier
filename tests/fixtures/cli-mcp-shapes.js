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
    native: {
      codex: { command, args: ["--flag"], env: {}, cwd: "/tmp" },
      opencode: {
        type: "local",
        command: [command, "--flag"],
        environment: {},
        cwd: "/tmp",
        enabled: true,
      },
    },
    unsupported: { claude: "cwd" },
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
    // Codex takes both timeouts in seconds; Claude Code and OpenCode only a per-server
    // request timeout in milliseconds, which carries the tool timeout.
    id: "stdio-timeouts",
    central: { ...stdio(), startupTimeoutSec: 30, toolTimeoutSec: 450 },
    secrets: none,
    native: {
      claude: { type: "stdio", command, args: ["--flag"], env: {}, timeout: 450000 },
      codex: {
        command,
        args: ["--flag"],
        env: {},
        startup_timeout_sec: 30,
        tool_timeout_sec: 450,
      },
      opencode: {
        type: "local",
        command: [command, "--flag"],
        environment: {},
        enabled: true,
        timeout: 450000,
      },
    },
  },
  {
    id: "http-timeouts",
    central: { ...remote("http"), toolTimeoutSec: 3600 },
    secrets: header,
    native: {
      claude: { type: "http", url, headers: header.headers, timeout: 3600000 },
      codex: { url, http_headers: header.headers, tool_timeout_sec: 3600 },
      opencode: {
        type: "remote",
        url,
        headers: header.headers,
        enabled: true,
        timeout: 3600000,
      },
    },
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
