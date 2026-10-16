import { plainText, webLink } from "../mcp-packages/publisher-info.js";
import { packageRef } from "../mcp-packages/package-spec.js";

// The MCP Registry's server.json is untrusted: every field is read by name, checked
// and capped; unknown fields, icons and publisher-provided _meta are ignored. The
// browser only ever sees this DTO.
const official = "io.modelcontextprotocol.registry/official";
const namePattern = /^[A-Za-z0-9.-]{1,150}\/[A-Za-z0-9._-]{1,150}$/;
const schemaPattern = /\/schemas\/(\d{4}-\d{2}-\d{2})\/server\.schema\.json$/;
const firstSchema = "2025-09-16";
// The server's own env and header name rules (extensions/mcp-config.js values()).
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const reserved = new Set(["__proto__", "constructor", "prototype"]);
const variableName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const template = /\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}/g;
const isoDate =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const bases = { npm: "https://registry.npmjs.org", pypi: "https://pypi.org" };
const limits = { name: 200, inputName: 100, options: 20, inputs: 100, choices: 50 };
Object.assign(limits, { args: 100, url: 2048, value: 16384 });
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, cap) => plainText(value, cap) ?? "";
const bool = (value) => value === true;

const notFound = () =>
  Object.assign(new Error("deleted"), { code: "MCP_DIRECTORY_NOT_FOUND" });
const invalid = () =>
  Object.assign(new Error("invalid"), { code: "MCP_DIRECTORY_INVALID" });

/** A cursor as the registry sent it, if it is short printable ASCII; else null. */
export const cursorOf = (value) =>
  typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value) ? value : null;

const choicesOf = (list) =>
  Array.isArray(list)
    ? list
        .slice(0, limits.choices)
        .map((choice) => text(choice, 200))
        .filter(Boolean)
    : [];

function variables(map) {
  if (!isRecord(map)) return [];
  return Object.entries(map)
    .filter(
      ([name, value]) =>
        variableName.test(name) && !reserved.has(name) && isRecord(value),
    )
    .slice(0, limits.inputs)
    .map(([name, value]) => ({
      name,
      description: text(value.description, 500),
      required: bool(value.isRequired),
      secret: bool(value.isSecret),
      default: plainText(value.default, limits.value),
      choices: choicesOf(value.choices),
    }));
}

/**
 * One variable per `{name}` in a template, declared ones as given. The registry often
 * leaves them undeclared (Smithery's "Bearer {smithery_api_key}"); those are required
 * and as secret as the value they sit in.
 */
function templateVariables(value, declared, secret = false) {
  if (typeof value !== "string") return [];
  const names = [...new Set([...value.matchAll(template)].map((match) => match[1]))];
  const known = new Map(variables(declared).map((variable) => [variable.name, variable]));
  return names
    .filter((name) => !reserved.has(name))
    .slice(0, limits.inputs)
    .map(
      (name) =>
        known.get(name) ?? {
          name,
          description: "",
          required: true,
          secret,
          default: null,
          choices: [],
        },
    );
}

function inputs(list, kind) {
  if (!Array.isArray(list)) return [];
  const rule = kind === "header" ? headerName : envName;
  return list
    .filter(
      (item) =>
        isRecord(item) &&
        typeof item.name === "string" &&
        item.name.length <= limits.inputName &&
        !reserved.has(item.name) &&
        rule.test(item.name),
    )
    .slice(0, limits.inputs)
    .map((item) => {
      const value = plainText(item.value, limits.value);
      return {
        name: item.name,
        description: text(item.description, 500),
        required: bool(item.isRequired),
        secret: bool(item.isSecret),
        format: typeof item.format === "string" ? text(item.format, 20) : "string",
        default: plainText(item.default, limits.value),
        choices: choicesOf(item.choices),
        value,
        variables: templateVariables(value, item.variables, bool(item.isSecret)),
      };
    });
}

/** An http(s) URL that may hold `{var}` templates; no credentials, no fragment. */
function templateUrl(value) {
  if (typeof value !== "string" || value.length > limits.url) return null;
  if (/[\x00-\x20\x7f\\]/.test(value)) return null;
  const probe = value.replace(template, "x");
  if (/[{}#]/.test(probe) || !webLink(probe)) return null;
  return value;
}

const blank = (extra) => ({
  kind: "unsupported",
  identifier: "",
  version: "",
  transport: "stdio",
  url: null,
  urlVariables: [],
  env: [],
  headers: [],
  packageArgs: [],
  ignored: [],
  unsupportedReason: null,
  ...extra,
});

/** Package arguments as rows; null when one needs a secret or the owner's own value. */
function packageArgs(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  const rows = [];
  for (const arg of list.slice(0, limits.args)) {
    if (!isRecord(arg) || arg.isSecret === true) return null;
    const value = plainText(arg.value ?? arg.default, limits.value);
    if (value !== null && /\{[^}]+\}/.test(value)) return null;
    if (value === null && arg.isRequired === true) return null;
    if (arg.type === "named") {
      const name =
        typeof arg.name === "string" && /^-{1,2}[A-Za-z0-9][\w.-]{0,63}$/.test(arg.name)
          ? arg.name
          : null;
      if (!name) return null;
      rows.push(name, ...(value === null ? [] : [value]));
    } else if (value !== null) rows.push(value);
  }
  return rows;
}

/** "ok" for a valid name and exact version, else which of the two is wrong. */
function refCheck(registry, name, version) {
  try {
    packageRef({ registry, name, version });
    return "ok";
  } catch {
    try {
      packageRef({ registry, name, version: registry === "npm" ? "1.0.0" : "1.0" });
      return "version";
    } catch {
      return "identifier";
    }
  }
}

function packageOption(pkg) {
  if (!isRecord(pkg)) return blank({ unsupportedReason: "registryType" });
  const registry = pkg.registryType;
  const transport = isRecord(pkg.transport)
    ? text(pkg.transport.type, 30) || "stdio"
    : "stdio";
  const shown = {
    identifier: text(pkg.identifier, 214),
    version: text(pkg.version, 128),
    transport,
  };
  if (registry !== "npm" && registry !== "pypi")
    return blank({
      ...shown,
      unsupportedReason: "registryType",
      registryType: text(registry, 30),
    });
  if (pkg.registryBaseUrl !== undefined && pkg.registryBaseUrl !== bases[registry])
    return blank({ ...shown, unsupportedReason: "registryBaseUrl" });
  const check = refCheck(registry, pkg.identifier, pkg.version);
  if (check !== "ok") return blank({ ...shown, unsupportedReason: check });
  if (transport !== "stdio") return blank({ ...shown, unsupportedReason: "transport" });
  const env = inputs(pkg.environmentVariables, "env");
  const args = packageArgs(pkg.packageArguments);
  if (args === null) return blank({ ...shown, unsupportedReason: "argument", env });
  return blank({
    ...shown,
    kind: registry,
    identifier: pkg.identifier,
    version: pkg.version,
    env,
    packageArgs: args,
    ignored: [
      ...(pkg.runtimeHint !== undefined ? ["runtimeHint"] : []),
      ...(Array.isArray(pkg.runtimeArguments) && pkg.runtimeArguments.length
        ? ["runtimeArguments"]
        : []),
    ],
  });
}

const remoteKinds = {
  "streamable-http": "remote-http",
  streamableHttp: "remote-http",
  http: "remote-http",
  sse: "remote-sse",
};

function remoteOption(remote) {
  if (!isRecord(remote)) return blank({ unsupportedReason: "transport" });
  const kind = Object.hasOwn(remoteKinds, remote.type) ? remoteKinds[remote.type] : null;
  if (!kind)
    return blank({ transport: text(remote.type, 30), unsupportedReason: "transport" });
  const transport = kind === "remote-sse" ? "sse" : "http";
  const url = templateUrl(remote.url);
  if (!url) return blank({ transport, unsupportedReason: "url" });
  return blank({
    kind,
    transport,
    url,
    urlVariables: templateVariables(url, remote.variables),
    headers: inputs(remote.headers, "header"),
  });
}

const schemaAccepted = (schema) => {
  if (schema === undefined) return true;
  const date = typeof schema === "string" ? schemaPattern.exec(schema)?.[1] : null;
  return Boolean(date) && date >= firstSchema;
};

function statusOf(item, server) {
  const meta = isRecord(item._meta?.[official])
    ? item._meta[official]
    : isRecord(server._meta?.[official])
      ? server._meta[official]
      : {};
  const raw = meta.status ?? server.status;
  return {
    status:
      raw === "deleted" ? "deleted" : raw === "deprecated" ? "deprecated" : "active",
    statusMessage: text(meta.statusMessage ?? server.statusMessage, 300),
    publishedAt:
      [meta.publishedAt, meta.updatedAt].find(
        (v) => typeof v === "string" && isoDate.test(v) && Number.isFinite(Date.parse(v)),
      ) ?? null,
  };
}

/** One registry item as the DTO, or null for an invalid or deleted entry. */
export function normaliseEntry(item) {
  if (!isRecord(item)) return null;
  const server = isRecord(item.server) ? item.server : item;
  if (
    typeof server.name !== "string" ||
    server.name.length > limits.name ||
    !namePattern.test(server.name)
  )
    return null;
  if (typeof server.version !== "string" || !/^[\x21-\x7e]{1,128}$/.test(server.version))
    return null;
  if (!schemaAccepted(server.$schema)) return null;
  const state = statusOf(item, server);
  if (state.status === "deleted") return null;
  const options = [
    ...(Array.isArray(server.packages) ? server.packages : []).map(packageOption),
    ...(Array.isArray(server.remotes) ? server.remotes : []).map(remoteOption),
  ].slice(0, limits.options);
  return {
    name: server.name,
    title: text(server.title, 100),
    description: text(server.description, 300),
    version: server.version,
    namespace: server.name.split("/")[0],
    ...state,
    repositoryUrl: webLink(isRecord(server.repository) ? server.repository.url : null),
    websiteUrl: webLink(server.websiteUrl),
    options,
    installable: options.some((option) => option.kind !== "unsupported"),
  };
}

/** A list response as entries (invalid and deleted ones dropped) and a safe cursor. */
export function normaliseList(body) {
  const list =
    isRecord(body) && Array.isArray(body.servers) ? body.servers.slice(0, 100) : [];
  return {
    entries: list.map(normaliseEntry).filter(Boolean),
    nextCursor: cursorOf(isRecord(body?.metadata) ? body.metadata.nextCursor : null),
  };
}

/** A detail response as one entry; a deleted entry is not found, anything else invalid. */
export function normaliseDetail(body) {
  if (!isRecord(body)) throw invalid();
  const server = isRecord(body.server) ? body.server : body;
  if (statusOf(body, server).status === "deleted") throw notFound();
  const entry = normaliseEntry(body);
  if (!entry) throw invalid();
  return entry;
}
