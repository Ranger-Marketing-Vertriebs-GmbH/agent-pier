import { serverMessages } from "../../lib/i18n/de.js";
import { assertUnlinkedPath, assertUniqueJsonKeys } from "../../lib/config-boundary.js";
import fs from "node:fs";
import path from "node:path";

import { randomUUID } from "node:crypto";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parseForESLint } from "toml-eslint-parser";
import { parse as parseJsonc, parseTree, modify, applyEdits } from "jsonc-parser";
import { problem } from "../../lib/storage.js";

export const own = (obj, key) => Object.hasOwn(obj, key);
export const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
export function nameValue(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value) ||
    ["constructor", "prototype", "__proto__"].includes(value)
  )
    throw problem(serverMessages.extensions.invalidMcpName);
  return value;
}
export function values(value = {}, headers = false) {
  if (!record(value) || Object.keys(value).length > 100)
    throw problem(serverMessages.extensions.invalidEnvironmentOrHeadersObject);
  for (const [key, item] of Object.entries(value))
    if (
      !(headers ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(
        key,
      ) ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      typeof item !== "string" ||
      item.length > 16384 ||
      /[\x00\r\n]/.test(item)
    )
      throw problem(serverMessages.extensions.invalidEnvironmentOrHeader);
  return value;
}
export function cleanMcp(input = {}) {
  const name = nameValue(input.name);
  if (input.transport === "stdio") {
    if (
      typeof input.command !== "string" ||
      !input.command.trim() ||
      input.command.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(input.command)
    )
      throw problem(serverMessages.extensions.executableCommandRequired);
    const args = input.args ?? [];
    if (
      !Array.isArray(args) ||
      args.length > 100 ||
      args.some(
        (arg) => typeof arg !== "string" || arg.length > 16384 || /[\x00]/.test(arg),
      )
    )
      throw problem(serverMessages.extensions.invalidArgumentList);
    return {
      name,
      transport: "stdio",
      command: input.command.trim(),
      args,
      env: values(input.env),
    };
  }
  if (input.transport !== "http")
    throw problem(serverMessages.extensions.transportRequired);
  let url;
  try {
    url = new URL(input.url);
  } catch {
    throw problem(serverMessages.extensions.invalidMcpUrl);
  }
  if (
    typeof input.url !== "string" ||
    input.url.length > 4096 ||
    /[\x00-\x1f\x7f\\]/.test(input.url) ||
    url.username ||
    url.password ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw problem(serverMessages.extensions.mcpUrlCredentialsForbidden);
  return {
    name,
    transport: "http",
    url: url.href,
    headers: values(input.headers, true),
  };
}
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
    };
  }
  if (tool === "codex") return { url: entry.url, http_headers: entry.headers };
  return {
    type: tool === "claude" ? "http" : "remote",
    url: entry.url,
    headers: entry.headers,
    ...(tool === "opencode" ? { enabled: true } : {}),
  };
}
export function publicMcp(name, entry, source) {
  let origin = "";
  try {
    origin = new URL(entry.url).origin;
  } catch {
    /* Existing command server or invalid URL. */
  }
  const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
  return {
    name,
    source,
    transport: entry.url ? "http" : "stdio",
    command: typeof command === "string" ? command : "",
    url: origin,
    argumentCount: Array.isArray(entry.command)
      ? Math.max(0, entry.command.length - 1)
      : Array.isArray(entry.args)
        ? entry.args.length
        : 0,
    environmentKeys: Object.keys(entry.env || entry.environment || {}),
    headerKeys: Object.keys(entry.http_headers || entry.headers || {}),
    enabled: entry.enabled !== false,
  };
}
export function safePath(target, boundary) {
  assertUnlinkedPath(target, boundary, {
    outside: serverMessages.extensions.targetOutsideProfile,
    linked: serverMessages.extensions.linkedPathsReadOnly,
  });
}
export function textFile(file, boundary) {
  safePath(file, boundary);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw problem(serverMessages.extensions.invalidCliConfigFile, 409);
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}
export function readConfig(file, boundary, tool) {
  const text = textFile(file, boundary);
  try {
    const errors = [];
    const options = {
      allowTrailingComma: tool === "opencode",
      disallowComments: tool === "claude",
    };
    if (tool !== "codex" && text.trim()) {
      const tree = parseTree(text, errors, options);
      assertUniqueJsonKeys(tree);
    }
    const data = text.trim()
      ? tool === "codex"
        ? parseToml(text)
        : parseJsonc(text, errors, options)
      : {};
    if (errors.length || !record(data)) throw new Error();
    return { file, text, data };
  } catch {
    throw problem(serverMessages.extensions.invalidExistingCliConfig, 409);
  }
}
export function atomicText(file, boundary, before, after) {
  safePath(file, boundary);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, after, { flag: "wx", mode: 0o600 });
    safePath(file, boundary);
    if (textFile(file, boundary) !== before)
      throw problem(serverMessages.extensions.cliConfigChanged, 409);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function updateConfig(config, boundary, tool, key, name, entry) {
  let after;
  if (tool === "codex") {
    const current = { ...(config.data[key] || {}) };
    if (entry === undefined) delete current[name];
    else current[name] = entry;
    const ast = parseForESLint(config.text).ast;
    const ranges = ast.body[0].body
      .filter(
        (node) =>
          (node.resolvedKey?.[0] ??
            node.key?.keys?.[0]?.name ??
            node.key?.keys?.[0]?.value) === key,
      )
      .map((node) => node.range)
      .sort((a, b) => b[0] - a[0]);
    after = config.text;
    for (const [start, end] of ranges) after = after.slice(0, start) + after.slice(end);
    after = `${after.trimEnd()}\n\n${stringifyToml({ [key]: current })}`;
    parseToml(after);
  } else
    after = applyEdits(
      config.text || "{}\n",
      modify(config.text || "{}\n", [key, name], entry, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
  atomicText(config.file, boundary, config.text, after);
}
