import { parse, stringify } from "smol-toml";
import { parseForESLint } from "toml-eslint-parser";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { tomlValue } from "../../lib/launch-serialization.js";
import { atomicText, CLI_CONFIG_CHANGED, textFile } from "../extensions/mcp-config.js";

/**
 * Codex defaults both credential stores to `auto`, which prefers the macOS login
 * keychain. Those keychain entries are not scoped by CODEX_HOME, so a managed account
 * would share its ChatGPT login and MCP OAuth tokens with every other account and the
 * owner. Managed accounts therefore keep both stores inside their own CODEX_HOME.
 */
export const CODEX_FILE_CREDENTIAL_STORES = Object.freeze({
  cli_auth_credentials_store: "file",
  mcp_oauth_credentials_store: "file",
});

const KEYS = Object.keys(CODEX_FILE_CREDENTIAL_STORES);
const pinLine = (key) => `${key} = ${tomlValue(CODEX_FILE_CREDENTIAL_STORES[key])}`;

export const codexCredentialStoreConfig = () =>
  KEYS.map((key) => `${pinLine(key)}\n`).join("");

/**
 * Codex layers a trusted project's `.codex/config.toml` over CODEX_HOME, so the file
 * pins alone do not hold; command-line overrides take precedence over both.
 */
export const codexCredentialStoreArgs = () =>
  KEYS.flatMap((key) => ["-c", `${key}=${tomlValue(CODEX_FILE_CREDENTIAL_STORES[key])}`]);

const pinned = (config) =>
  Object.entries(CODEX_FILE_CREDENTIAL_STORES).every(
    ([key, value]) => config[key] === value,
  );

// Replaces only the value tokens of existing top-level pins and prepends missing ones,
// so inline comments, line endings, other keys and tables stay byte-for-byte.
function targetedEdit(text, config) {
  const nodes = parseForESLint(text).ast.body[0].body;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const replacements = [];
  let prefix = "";
  for (const key of KEYS) {
    if (config[key] === CODEX_FILE_CREDENTIAL_STORES[key]) continue;
    const node = nodes.find(
      (node) =>
        node.type === "TOMLKeyValue" &&
        node.key.keys.length === 1 &&
        (node.key.keys[0].name ?? node.key.keys[0].value) === key,
    );
    if (node) replacements.push({ key, range: node.value.range });
    else prefix += `${pinLine(key)}${eol}`;
  }
  let next = text;
  for (const { key, range } of replacements.sort((a, b) => b.range[0] - a.range[0]))
    next = `${next.slice(0, range[0])}${tomlValue(CODEX_FILE_CREDENTIAL_STORES[key])}${next.slice(range[1])}`;
  return prefix + next;
}

function repairedText(text) {
  let config;
  try {
    config = parse(text);
  } catch {
    // Codex itself reports a config it cannot read.
    return null;
  }
  if (pinned(config)) return null;
  try {
    const next = targetedEdit(text, config);
    if (pinned(parse(next))) return next;
  } catch {
    // Layouts the edit cannot address (for example a byte-order mark) fall through.
  }
  return stringify({ ...config, ...CODEX_FILE_CREDENTIAL_STORES });
}

/**
 * Repairs the pins in a managed account's config.toml. The write is a compare-and-swap
 * inside the account profile, refuses linked paths and is retried when a running Codex
 * of the same account changed the file in between.
 */
export function pinCodexCredentialStores(file, boundary) {
  for (let attempt = 0; ; attempt++) {
    let text;
    try {
      text = textFile(file, boundary);
    } catch (error) {
      if (error.status) throw error;
      throw problem(serverMessages.accounts.codexConfigUnreadable, 409);
    }
    const next = repairedText(text);
    if (next === null) return false;
    try {
      atomicText(file, boundary, text, next);
      return true;
    } catch (error) {
      if (error.code !== CLI_CONFIG_CHANGED || attempt >= 2) throw error;
    }
  }
}
