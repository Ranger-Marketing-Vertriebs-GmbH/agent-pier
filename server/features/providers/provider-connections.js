import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { problem, nameValue, writePrivate } from "../../lib/storage.js";
import { providerDefinition } from "./provider-definitions.js";
import { endpointOrigins, endpointTools, validateEndpoint } from "./endpoint-config.js";
const validId = (id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
function read(file, fallback) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)
      throw problem(serverMessages.providers.unsafeConnectionStorage);
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
function inputValue(input, creation) {
  const allowed = [
    "name",
    "apiKey",
    "responsesAccess",
    "endpoint",
    ...(creation ? ["providerId"] : ["removeApiKey"]),
  ];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw problem(serverMessages.providers.invalidConnectionFields);
  if (
    input.apiKey !== undefined &&
    (typeof input.apiKey !== "string" ||
      input.apiKey.length > 16384 ||
      /[\x00-\x1f]/.test(input.apiKey))
  )
    throw problem(serverMessages.providers.invalidApiKey);
  if (input.removeApiKey !== undefined && typeof input.removeApiKey !== "boolean")
    throw problem(serverMessages.providers.invalidKeyRemoval);
  if (input.responsesAccess !== undefined && typeof input.responsesAccess !== "boolean")
    throw problem(serverMessages.providers.responsesAccessBoolean);
  if (input.removeApiKey && input.apiKey?.trim())
    throw problem(serverMessages.accounts.keyRotationOrRemoval);
  return input.apiKey?.trim();
}
export class ProviderConnections {
  constructor({ dataDir }) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = fs.realpathSync(dataDir);
    this.file = path.join(this.dataDir, "provider-connections.json");
    this.directory = path.join(this.dataDir, "provider-connection-secrets");
    this.launches = new Map();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(this.directory);
    if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()))
      throw problem(serverMessages.providers.unsafeConnectionDirectory);
    fs.chmodSync(this.directory, 0o700);
    this.invalid = [];
    this.skipped = [];
    this.records = read(this.file, []);
    if (
      !Array.isArray(this.records) ||
      this.records.some((record) => !validId(record.id))
    )
      throw problem(serverMessages.providers.invalidConnectionStorage);
    this.records = this.records.filter((record) => {
      if (record.providerId !== "endpoint") return true;
      try {
        record.endpoint = validateEndpoint(record.endpoint);
        return true;
      } catch {
        this.invalid.push(record.id);
        this.skipped.push(record);
        return false;
      }
    });
  }
  record(id) {
    const record = validId(id) && this.records.find((value) => value.id === id);
    if (!record) throw problem(serverMessages.providers.connectionNotFound, 404);
    return record;
  }
  secret(id) {
    if (!validId(id) || !this.records.some((record) => record.id === id)) return null;
    return read(path.join(this.directory, `${id}.json`), null);
  }
  public(record) {
    const definition = providerDefinition(record.providerId);
    const hasSecret = !!this.secret(record.id)?.apiKey;
    const endpoint = definition.kind === "endpoint";
    return {
      id: record.id,
      name: record.name,
      providerId: record.providerId,
      hasSecret,
      launchable: hasSecret || !definition.keyRequired,
      tools: endpoint
        ? endpointTools(record.endpoint)
        : definition.tools.filter(
            (tool) =>
              tool !== "codex" ||
              !definition.responsesGate ||
              record.responsesAccess === true,
          ),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(definition.responsesGate
        ? { responsesAccess: record.responsesAccess === true }
        : {}),
      ...(endpoint ? { endpoint: structuredClone(record.endpoint) } : {}),
    };
  }
  list() {
    return this.records.map((record) => this.public(record));
  }
  get(id) {
    return this.public(this.record(id));
  }
  save() {
    writePrivate(this.file, [...this.records, ...this.skipped]);
  }
  acquire(id) {
    this.record(id);
    this.launches.set(id, (this.launches.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.launches.get(id) - 1;
      if (remaining) this.launches.set(id, remaining);
      else this.launches.delete(id);
    };
  }
  requireMutable(id) {
    if (this.launches.has(id))
      throw problem(serverMessages.providers.connectionPreparingSession, 409);
  }
  create(input) {
    const key = inputValue(input, true),
      name = nameValue(input.name);
    const definition = providerDefinition(input.providerId);
    if (!definition.responsesGate && input.responsesAccess !== undefined)
      throw problem(serverMessages.providers.responsesEntitlementZaiOnly);
    if ((definition.kind === "endpoint") !== (input.endpoint !== undefined))
      throw problem(serverMessages.providers.invalidConnectionFields);
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      name,
      providerId: input.providerId,
      createdAt: now,
      updatedAt: now,
      ...(definition.responsesGate
        ? { responsesAccess: input.responsesAccess === true }
        : {}),
      ...(definition.kind === "endpoint"
        ? { endpoint: validateEndpoint(input.endpoint) }
        : {}),
    };
    if (key)
      writePrivate(path.join(this.directory, `${record.id}.json`), { apiKey: key });
    this.records.push(record);
    this.save();
    return this.public(record);
  }
  update(id, input) {
    this.requireMutable(id);
    const key = inputValue(input, false),
      current = this.record(id);
    const definition = providerDefinition(current.providerId);
    if (!definition.responsesGate && input.responsesAccess !== undefined)
      throw problem(serverMessages.providers.responsesEntitlementZaiOnly);
    if (input.endpoint !== undefined && definition.kind !== "endpoint")
      throw problem(serverMessages.providers.invalidConnectionFields);
    const endpoint =
      input.endpoint !== undefined ? validateEndpoint(input.endpoint) : current.endpoint;
    if (
      endpoint &&
      this.secret(id)?.apiKey &&
      !key &&
      !input.removeApiKey &&
      JSON.stringify(endpointOrigins(endpoint)) !==
        JSON.stringify(endpointOrigins(current.endpoint))
    )
      throw problem(serverMessages.providers.endpointKeyReentryRequired, 409);
    const record = {
      ...current,
      ...(input.name !== undefined ? { name: nameValue(input.name) } : {}),
      ...(input.responsesAccess !== undefined
        ? { responsesAccess: input.responsesAccess }
        : {}),
      ...(endpoint ? { endpoint } : {}),
      updatedAt: new Date().toISOString(),
    };
    const file = path.join(this.directory, `${id}.json`);
    if (input.removeApiKey) fs.rmSync(file, { force: true });
    else if (key) writePrivate(file, { apiKey: key });
    this.records = this.records.map((value) => (value.id === id ? record : value));
    this.save();
    return this.public(record);
  }
  remove(id) {
    this.record(id);
    this.requireMutable(id);
    fs.rmSync(path.join(this.directory, `${id}.json`), { force: true });
    this.records = this.records.filter((record) => record.id !== id);
    this.save();
  }
}
