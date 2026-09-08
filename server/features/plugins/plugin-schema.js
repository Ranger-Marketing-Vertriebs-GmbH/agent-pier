import { serverMessages } from "../../lib/i18n/de.js";
import { assertUnlinkedPath, assertUniqueJsonKeys } from "../../lib/config-boundary.js";
import fs from "node:fs";

import { isIP } from "node:net";
import { parse, parseTree } from "jsonc-parser";

import { problem } from "../../lib/storage.js";
export const LIMIT = 2 * 1024 * 1024;
export const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
export const string = (value) => (typeof value === "string" ? value : "");
export const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
export const npmPattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._+-]*)?$/;
export const npmName = (spec) => spec.replace(/@[^@/]+$/, "");
export const npmVersion = (spec) =>
  spec.slice(npmName(spec).length).replace(/^@/, "") || null;
export function selector(value) {
  if (
    typeof value !== "string" ||
    value.length > 401 ||
    !value.split("@").every((part) => namePattern.test(part)) ||
    value.split("@").length !== 2
  )
    throw problem(serverMessages.plugins.catalogSelectionRequired);
  return value;
}
export function marketName(value) {
  if (typeof value !== "string" || !namePattern.test(value))
    throw problem(serverMessages.plugins.invalidMarketplaceName);
  return value;
}
export function npmSpec(value) {
  if (typeof value !== "string" || value.length > 300 || !npmPattern.test(value))
    throw problem(serverMessages.plugins.npmPackageRequired);
  return value;
}
export function marketSource(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\\]/.test(value))
    throw problem(serverMessages.plugins.publicRepositoryRequired);
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value))
    return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw problem(serverMessages.plugins.publicRepositoryRequired);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !host.includes(".") ||
    isIP(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
    !url.pathname ||
    url.pathname === "/"
  )
    throw problem(serverMessages.plugins.marketplaceUrlRestricted);
  return url.href;
}
export function safePath(target, boundary) {
  assertUnlinkedPath(target, boundary, {
    outside: serverMessages.plugins.pathOutsideProfile,
    linked: serverMessages.plugins.linkedConfigReadOnly,
  });
}
export function configFile(file, boundary) {
  safePath(file, boundary);
  let text;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > LIMIT)
      throw problem(serverMessages.plugins.invalidConfigFile, 409);
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const errors = [];
  const options = { allowTrailingComma: true };
  const tree = parseTree(text, errors, options);
  try {
    assertUniqueJsonKeys(tree);
  } catch {
    throw problem(serverMessages.plugins.duplicateConfigKeys, 409);
  }
  const data = text.trim() ? parse(text, errors, options) : {};
  if (
    errors.length ||
    !object(data) ||
    (data.plugin !== undefined && !Array.isArray(data.plugin))
  )
    throw problem(serverMessages.plugins.invalidExistingConfig, 409);
  return { file, text, data };
}
export function redacted(value, env = {}) {
  let text = string(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const [key, secret] of Object.entries(env))
    if (
      /KEY|TOKEN|SECRET|PASSWORD/i.test(key) &&
      typeof secret === "string" &&
      secret.length > 3
    )
      text = text.replaceAll(secret, "[verborgen]");
  return text
    .replace(/https?:\/\/[^\s<>"']+/g, (match) => {
      try {
        const url = new URL(match);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href;
      } catch {
        return "[URL]";
      }
    })
    .slice(0, 1800);
}
export function marketplaceRow(item, tool) {
  const native = item.marketplaceSource;
  const source =
    tool === "codex"
      ? native?.source || item.root
      : item.repo || item.url || item.path || item.source;
  const editable = tool !== "codex" || !!native;
  return {
    name: string(item.name),
    source: redacted(source),
    removable: editable,
    updatable: editable,
  };
}
export function pluginRow(item, tool, installed) {
  const id = string(item.pluginId || item.id);
  const parts = id.split("@");
  const scope = string(item.scope) || (tool === "codex" ? "user" : "user");
  return {
    id,
    name: string(item.name) || parts[0],
    description: string(item.description),
    version: string(item.version) || null,
    enabled: item.enabled !== false,
    marketplace: string(item.marketplaceName) || parts[1] || "",
    scope,
    installed,
    removable: scope === "user",
  };
}
