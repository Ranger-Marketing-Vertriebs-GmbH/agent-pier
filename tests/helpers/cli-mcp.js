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
    /** The CLI's MCP entries as its file holds them now, as plain objects. */
    entries(cli) {
      if (!fs.existsSync(file(cli))) return {};
      const text = fs.readFileSync(file(cli), "utf8");
      const data = cli === "codex" ? parseToml(text) : parseJsonc(text);
      // smol-toml yields null-prototype objects, which strict deep equality tells apart.
      return JSON.parse(JSON.stringify(data[keys[cli]] ?? {}));
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
