import { mapCommand } from "./command-mapper.js";
import { isPlaceholder, looksLikeToken } from "./paste-placeholders.js";
import { sanitiseName, uniqueName } from "./server-name.js";
import { addressWarnings, isSecretName } from "./setting-hints.js";
import { hasReference, referenceName } from "./value-references.js";
import { guessTransport } from "./wizard-state.js";

// One server entry from a guide → a wizard draft with every dropped key, reference
// and placeholder named. Values are taken as literals or left empty and required.
export const entryLimits = { args: 100, entries: 100, value: 16384 };
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const control = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const unmanaged = new Set([
  "disabled",
  "enabled",
  "autoApprove",
  "alwaysAllow",
  "timeout",
  "trust",
  "includeTools",
  "excludeTools",
]);
const handled = new Set([
  "command",
  "args",
  "env",
  "environment",
  "cwd",
  "url",
  "serverUrl",
  "headers",
  "type",
  "transport",
  "transportType",
]);
const remoteTypes = {
  http: "http",
  "streamable-http": "http",
  streamableHttp: "http",
  sse: "sse",
};
const stdioTypes = new Set(["stdio", "local"]);
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const shown = (key) => String(key).slice(0, 60);
const refuse = (code) => Object.assign(new Error(code), { code });

/** A literal value, or empty + required with the reason; null drops the setting. */
function literal(name, raw, { notes, inputs, header }) {
  let value = raw;
  if (typeof value === "number" || typeof value === "boolean") {
    notes.warnings.push({ code: "stringified", name });
    value = String(value);
  }
  if (typeof value !== "string") {
    notes.ignored.push({ key: shown(name), code: "notString" });
    return null;
  }
  if (value.length > entryLimits.value) {
    notes.warnings.push({ code: "tooLongValue", name });
    return { value: "", required: true };
  }
  if (control.test(value)) {
    notes.warnings.push({ code: "controlChars", name });
    return { value: "", required: true };
  }
  if (hasReference(value)) {
    const input = /\$\{input:([^}]+)\}/.exec(value)?.[1];
    notes.warnings.push({ code: "reference", name, ref: referenceName(value) });
    const described = input && inputs[input];
    return {
      value: "",
      required: true,
      ...(described
        ? { description: described.description, secret: described.password === true }
        : {}),
    };
  }
  if (isPlaceholder(header ? value.replace(/^bearer\s+/i, "") : value)) {
    notes.warnings.push({ code: "placeholder", name });
    return { value: "", required: true };
  }
  return { value };
}

function settingRows(map, kind, context) {
  const rows = [];
  const settings = {};
  if (map === undefined) return { rows, settings };
  if (!isRecord(map)) {
    context.notes.ignored.push({
      key: kind === "header" ? "headers" : "env",
      code: "notString",
    });
    return { rows, settings };
  }
  const names = Object.keys(map);
  if (names.length > entryLimits.entries)
    context.notes.warnings.push({ code: "tooMany" });
  for (const name of names.slice(0, entryLimits.entries)) {
    if (!(kind === "header" ? headerName : envName).test(name)) {
      context.notes.ignored.push({ key: shown(name), code: "invalidName" });
      continue;
    }
    const raw = map[name];
    const result = literal(name, raw, { ...context, header: kind === "header" });
    if (!result) continue;
    const bearer =
      kind === "header" &&
      /^authorization$/i.test(name) &&
      /^bearer\s+/i.test(String(raw));
    rows.push({
      key: bearer ? "auth" : context.nextKey(),
      name,
      value: bearer ? result.value.replace(/^bearer\s+/i, "") : result.value,
      fixed: true,
      ...(bearer ? { bearer: true } : {}),
    });
    settings[name] = {
      required: result.required === true,
      secret: result.secret === true || isSecretName(name),
      ...(result.description
        ? { description: String(result.description).slice(0, 500) }
        : {}),
    };
  }
  return { rows, settings };
}

function argumentRows(list, { notes }) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string"))
    throw refuse("invalidArgs");
  if (list.length > entryLimits.args) notes.warnings.push({ code: "tooMany" });
  return list.slice(0, entryLimits.args).map((arg) => {
    if (arg.length > entryLimits.value || control.test(arg)) {
      notes.warnings.push({ code: "controlChars", name: "args" });
      return "";
    }
    if (hasReference(arg)) {
      notes.warnings.push({ code: "reference", name: "args", ref: referenceName(arg) });
      return "";
    }
    if (looksLikeToken(arg)) notes.warnings.push({ code: "tokenInArgs" });
    return arg;
  });
}

function remoteDraft(url, entry, type, context) {
  const { notes } = context;
  let transport = remoteTypes[type];
  if (!transport) {
    transport = guessTransport(url);
    if (transport === "sse") notes.warnings.push({ code: "guessed" });
  }
  let address = url;
  if (hasReference(url)) {
    notes.warnings.push({ code: "reference", name: "url", ref: referenceName(url) });
    address = "";
  } else if (addressWarnings(url).includes("tokenInQuery"))
    notes.warnings.push({ code: "tokenInQuery" });
  const { rows, settings } = settingRows(entry.headers, "header", context);
  return {
    path: "remote",
    transport,
    source: "command",
    url: address,
    signIn: rows.length ? "headers" : "none",
    headers: rows,
    argRows: [],
    hints: { settings },
  };
}

function stdioDraft(entry, context) {
  const { notes } = context;
  let command = entry.command;
  let args = entry.args;
  let env = entry.env ?? entry.environment;
  if (Array.isArray(command)) {
    if (!command.length || command.some((item) => typeof item !== "string"))
      throw refuse("invalidArgs");
    args = [...command.slice(1), ...(Array.isArray(entry.args) ? entry.args : [])];
    command = command[0];
  } else if (isRecord(command)) {
    // Zed: { path, args, env }.
    args = command.args;
    env = command.env ?? env;
    command = command.path;
  }
  if (typeof command !== "string" || !command.trim() || control.test(command))
    throw refuse("noCommand");
  const list = argumentRows(args, context);
  // A command that refers to another setting is not taken over either.
  const commandReference = hasReference(command);
  if (commandReference)
    notes.warnings.push({
      code: "reference",
      name: "command",
      ref: referenceName(command),
    });
  const { rows, settings } = settingRows(env, "env", context);
  let cwd = "";
  if (entry.cwd !== undefined) {
    if (
      typeof entry.cwd === "string" &&
      entry.cwd.startsWith("/") &&
      !hasReference(entry.cwd)
    )
      cwd = entry.cwd;
    else notes.warnings.push({ code: "cwdRelative" });
  }
  const mapped = commandReference
    ? {
        kind: "command",
        command: "",
        args: list,
        ignored: [],
        warnings: [],
        program: null,
      }
    : mapCommand(command.trim(), list);
  notes.ignored.push(...mapped.ignored);
  notes.warnings.push(...mapped.warnings);
  const common = {
    transport: "stdio",
    env: rows,
    argRows: mapped.args,
    cwd,
    hints: { settings, ...(mapped.program ? { program: mapped.program } : {}) },
  };
  if (mapped.kind === "command")
    return { ...common, path: "command", source: "command", command: mapped.command };
  return {
    ...common,
    path: "package",
    source: "package",
    registry: mapped.kind,
    packageName: mapped.packageName,
    packageVersion: mapped.version,
  };
}

/**
 * `key` is the entry's name in the block ("" for a single entry). `nextKey` makes the
 * row keys; the parser gives each server its own counter so results are deterministic.
 */
export function mapEntry(key, entry, { taken = [], inputs = {}, nextKey }) {
  const notes = { ignored: [], warnings: [] };
  const base = sanitiseName(key);
  const name = base ? uniqueName(base, taken) : "";
  if (base && base !== key)
    notes.warnings.push({ code: "nameChanged", name: shown(key), to: base });
  if (name !== base) notes.warnings.push({ code: "nameTaken", name: base, to: name });
  const context = { notes, inputs, nextKey };
  const type = [entry.type, entry.transport, entry.transportType].find(
    (value) => typeof value === "string",
  );
  const url = [entry.url, entry.serverUrl].find((value) => typeof value === "string");
  let draft;
  try {
    draft =
      url !== undefined && !stdioTypes.has(type)
        ? remoteDraft(url, entry, type, context)
        : stdioDraft(entry, context);
  } catch (error) {
    if (!error.code) throw error;
    return { key: shown(key), name, refused: error.code, ...notes };
  }
  if (entry.transportType !== undefined)
    notes.ignored.push({ key: "transportType", code: "consumed" });
  for (const field of Object.keys(entry)) {
    if (handled.has(field)) continue;
    const code = unmanaged.has(field)
      ? "unmanaged"
      : field === "envFile"
        ? "envFile"
        : field === "oauth"
          ? "oauth"
          : "unknown";
    notes.ignored.push({ key: shown(field), code });
  }
  return { key: shown(key), name, draft: { ...draft, name, origin: "paste" }, ...notes };
}
