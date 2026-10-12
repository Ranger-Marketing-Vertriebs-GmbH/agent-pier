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

// Stands in for `open`, `xdg-open` and $BROWSER (and for `security`, the macOS keychain
// tool): records what a CLI tried and fails, so no real browser starts, no keychain is
// touched through PATH, and a CLI falls back to printing its URL or to a file store.
const stub = (log, code) =>
  `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log.replaceAll("'", "'\\''")}'\nexit ${code}\n`;

/**
 * A throwaway HOME holding every CLI configuration, data, cache and credential
 * location: XDG directories, `CODEX_HOME`, and Claude Code's `CLAUDE_CONFIG_DIR` with
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` (as AgentPier's managed accounts set them), so no
 * CLI reads the owner's configuration files. The secure-storage directory only changes
 * the hashed service name of Claude Code's keychain items; the keychain itself is kept
 * out by the `security` stub on PATH, a browser by the `open`, `xdg-open` and BROWSER
 * stubs. `browserLog` and `keychainLog` collect every attempt.
 */
export function isolatedHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-cli-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  if (path.resolve(home) === path.resolve(os.homedir()))
    throw new Error("Refusing to run a CLI contract in the owner's HOME.");
  const bin = path.join(root, "bin");
  const browserLog = path.join(root, "browser.log");
  const keychainLog = path.join(root, "keychain.log");
  fs.mkdirSync(bin, { mode: 0o700 });
  for (const name of ["open", "xdg-open", "browser"])
    fs.writeFileSync(path.join(bin, name), stub(browserLog, 1), { mode: 0o700 });
  // 44 is `security`'s "item not found".
  fs.writeFileSync(path.join(bin, "security"), stub(keychainLog, 44), { mode: 0o700 });
  const claudeConfig = path.join(home, ".claude-config");
  const codexHome = path.join(home, ".codex");
  for (const dir of [claudeConfig, codexHome]) fs.mkdirSync(dir, { mode: 0o700 });
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: claudeConfig,
    DISABLE_AUTOUPDATER: "1",
    BROWSER: path.join(bin, "browser"),
    TERM: "dumb",
    NO_COLOR: "1",
  };
  return { root, home, env, claudeConfig, codexHome, browserLog, keychainLog };
}

const lines = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
/** What the CLIs tried to open in a browser (the stub refused each one). */
export const browserAttempts = ({ browserLog }) => lines(browserLog);
/** The `security` calls the CLIs made through PATH (the stub refused each one). */
export const keychainAttempts = ({ keychainLog }) => lines(keychainLog);

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

/** Codex keeps MCP OAuth tokens and any login in files inside CODEX_HOME, never the keychain. */
export const codexArgs = (...args) => [
  "-c",
  'mcp_oauth_credentials_store="file"',
  "-c",
  'cli_auth_credentials_store="file"',
  ...args,
];
