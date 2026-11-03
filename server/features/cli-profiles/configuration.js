import fs from "node:fs";
import path from "node:path";
import { stringify as toml } from "smol-toml";
import { applyEdits, modify } from "jsonc-parser";
import { parseForESLint } from "toml-eslint-parser";
import { readConfig, atomicText } from "../extensions/mcp-config.js";
import { cliDriver } from "../clis/drivers.js";
import { cliDefinition } from "../clis/catalog.js";

export function profileLocation(accounts, id) {
  const account = accounts.get(id),
    env = accounts.environment(id);
  const boundary = account.kind === "managed" ? accounts.profile(id) : accounts.home;
  const root = cliDriver(account.tool).configRoot(
    { ...env, HOME: accounts.home },
    accounts.home,
  );
  return { account, root, boundary, env };
}
export function documents(location) {
  const { account, root, env } = location;
  return cliDriver(account.tool).profileFiles.sharedDocuments(root, env);
}
export function readShared(location) {
  const output = {};
  for (const doc of documents(location)) {
    const config = readConfig(doc.file, location.boundary, location.account.tool);
    for (const key of doc.keys)
      if (config.data[key] !== undefined) {
        const name = path.basename(doc.file).startsWith("tui.") ? `tui:${key}` : key;
        const value =
          location.account.tool === "codex" && key === "plugins"
            ? scopedCodexPlugins(config.data[key], false)
            : config.data[key];
        output[name] = merge(value, output[name]);
      }
  }
  return output;
}
// Curated remote installation state belongs to the authenticated profile, even
// though Codex's downloaded plugin cache and local plugin settings are shared.
function scopedCodexPlugins(value, remote) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return remote ? undefined : value;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([id]) => id.endsWith("@openai-curated-remote") === remote,
    ),
  );
}
// The primary definition wins on conflicts; absent entries are retained from the fallback.
export function merge(primary, fallback) {
  if (primary === undefined) return fallback;
  if (Array.isArray(primary) && Array.isArray(fallback))
    return [
      ...new Map(
        [...primary, ...fallback].map((item) => [JSON.stringify(item), item]),
      ).values(),
    ];
  if (
    primary &&
    fallback &&
    typeof primary === "object" &&
    typeof fallback === "object" &&
    !Array.isArray(primary) &&
    !Array.isArray(fallback)
  ) {
    const result = { ...fallback };
    for (const [key, value] of Object.entries(primary))
      result[key] = merge(value, fallback[key]);
    return result;
  }
  return primary;
}
export function writeFields(file, boundary, tool, additions) {
  const before = readConfig(file, boundary, tool);
  if (
    Object.entries(additions).every(
      ([key, value]) => JSON.stringify(before.data[key]) === JSON.stringify(value),
    )
  )
    return;
  let next = before.text || "{}\n";
  if (cliDefinition(tool).configFormat === "toml") {
    next = before.text;
    const nodes = parseForESLint(next).ast.body[0].body;
    const ranges = nodes
      .filter((node) =>
        Object.hasOwn(
          additions,
          node.resolvedKey?.[0] ??
            node.key?.keys?.[0]?.name ??
            node.key?.keys?.[0]?.value,
        ),
      )
      .map((node) => node.range)
      .sort((a, b) => b[0] - a[0]);
    for (const [start, end] of ranges) next = next.slice(0, start) + next.slice(end);
    const fields = Object.fromEntries(
      Object.entries(additions).filter(([, value]) => value !== undefined),
    );
    next = `${next.trimEnd()}\n\n${toml(fields)}`;
  } else
    for (const [key, value] of Object.entries(additions))
      next = applyEdits(
        next,
        modify(next, [key], value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      );
  atomicText(file, boundary, before.text, next);
}
export function applyShared(location, values) {
  const docs = documents(location);
  for (const doc of docs) {
    if (!doc.createIfMissing && !fs.existsSync(doc.file)) continue;
    const additions = Object.fromEntries(
      doc.keys.map((key) => [
        key,
        values[path.basename(doc.file).startsWith("tui.") ? `tui:${key}` : key],
      ]),
    );
    if (location.account.tool === "codex") {
      const current = readConfig(doc.file, location.boundary, "codex").data.plugins;
      const ownRemote = scopedCodexPlugins(current, true);
      const shared = scopedCodexPlugins(additions.plugins, false);
      additions.plugins =
        ownRemote && Object.keys(ownRemote).length ? { ...shared, ...ownRemote } : shared;
    }
    if (
      !fs.existsSync(doc.file) &&
      Object.values(additions).every((value) => value === undefined)
    )
      continue;
    writeFields(doc.file, location.boundary, location.account.tool, additions);
  }
}

export function mergeShared(primary, fallback) {
  const result = { ...fallback };
  for (const [key, value] of Object.entries(primary)) {
    result[key] = Array.isArray(value)
      ? merge(value, fallback[key])
      : value && typeof value === "object"
        ? { ...fallback[key], ...value }
        : value;
  }
  return result;
}
