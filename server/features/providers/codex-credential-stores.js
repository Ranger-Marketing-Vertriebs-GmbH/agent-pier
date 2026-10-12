import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "smol-toml";
import { writeTomlConfig } from "./native-config.js";

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

const pinLine = (key) => `${key} = "${CODEX_FILE_CREDENTIAL_STORES[key]}"`;

export const codexCredentialStoreConfig = () =>
  Object.keys(CODEX_FILE_CREDENTIAL_STORES)
    .map((key) => `${pinLine(key)}\n`)
    .join("");

const pinned = (config) =>
  Object.entries(CODEX_FILE_CREDENTIAL_STORES).every(
    ([key, value]) => config[key] === value,
  );

/**
 * Repairs the pins of a managed account's config.toml with a targeted text edit: other
 * keys, tables, comments and formatting stay byte-for-byte. A file Codex itself cannot
 * read is left for Codex to report.
 */
export function pinCodexCredentialStores(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    text = "";
  }
  let config;
  try {
    config = parse(text);
  } catch {
    return false;
  }
  if (pinned(config)) return false;
  const lines = text.split("\n");
  const header = lines.findIndex((line) => /^\s*\[/.test(line));
  const topLevel = header === -1 ? lines.length : header;
  const missing = [];
  for (const key of Object.keys(CODEX_FILE_CREDENTIAL_STORES)) {
    if (config[key] === CODEX_FILE_CREDENTIAL_STORES[key]) continue;
    const pattern = new RegExp(`^\\s*${key}\\s*=`);
    const index = lines.slice(0, topLevel).findIndex((line) => pattern.test(line));
    if (index === -1) missing.push(pinLine(key));
    else lines[index] = pinLine(key);
  }
  const next = [...missing, ...lines].join("\n");
  const updated = next.endsWith("\n") || !next ? next : `${next}\n`;
  let result;
  try {
    result = parse(updated);
  } catch {
    result = {};
  }
  // An unusual layout (dotted or quoted keys) falls back to a structured rewrite.
  if (!pinned(result)) {
    writeTomlConfig(file, CODEX_FILE_CREDENTIAL_STORES);
    return true;
  }
  const temporary = path.join(path.dirname(file), `.config.toml.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, updated, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}
