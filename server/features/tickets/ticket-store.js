import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  privateDirectory,
  writePrivate,
  readJSON,
  problem,
  nameValue,
} from "../../lib/storage.js";

const MAX_STARTS = 500;
const DEFAULT_LABEL = "in progress";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const connectionId = /^[A-Za-z0-9_-]+$/;
const loopback = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

function baseUrlValue(value) {
  const invalid = () => problem(serverMessages.tickets.invalidBaseUrl);
  if (typeof value !== "string" || !value || value.length > 2048) throw invalid();
  if (/[\s\\\x00-\x1f\x7f]/.test(value) || /[?#]/.test(value)) throw invalid();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (url.username || url.password || url.search || url.hash || !url.hostname)
    throw invalid();
  if (url.protocol === "http:") {
    if (!loopback.has(url.hostname)) throw invalid();
  } else if (url.protocol !== "https:") throw invalid();
  return (url.origin + url.pathname).replace(/\/+$/, "");
}
function slugValue(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(value))
    throw problem(serverMessages.tickets.invalidWorkspace);
  return value;
}
function tokenValue(value) {
  if (typeof value !== "string" || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value))
    throw problem(serverMessages.tickets.invalidToken);
  return value.trim();
}
function labelValue(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 50 ||
    /[\x00-\x1f\x7f,]/.test(value)
  )
    throw problem(serverMessages.tickets.invalidLink);
  return value.trim();
}
function planeLink(value) {
  if (value == null) return null;
  const invalid = () => problem(serverMessages.tickets.invalidLink);
  if (typeof value !== "object" || Array.isArray(value)) throw invalid();
  if (typeof value.connectionId !== "string" || !connectionId.test(value.connectionId))
    throw invalid();
  if (typeof value.planeProjectId !== "string" || !uuid.test(value.planeProjectId))
    throw invalid();
  if (value.inProgressStateId != null && !uuid.test(String(value.inProgressStateId)))
    throw invalid();
  if (typeof value.identifier !== "string" || !/^[A-Z0-9]{1,12}$/.test(value.identifier))
    throw invalid();
  return {
    connectionId: value.connectionId,
    planeProjectId: value.planeProjectId,
    identifier: value.identifier,
    name: nameValue(value.name),
    inProgressStateId: value.inProgressStateId ?? null,
  };
}
function startRecord(value, now = Date.now) {
  const invalid = () => problem(serverMessages.tickets.invalidStart);
  if (!value || typeof value !== "object") throw invalid();
  const text = (field, max) => {
    if (typeof value[field] !== "string" || !value[field] || value[field].length > max)
      throw invalid();
    return value[field];
  };
  if (!["github", "plane"].includes(value.source)) throw invalid();
  if (!["session", "pipeline"].includes(value.kind)) throw invalid();
  const writeBack = value.writeBack || { state: "pending" };
  if (!["pending", "done", "failed"].includes(writeBack.state)) throw invalid();
  return {
    id: typeof value.id === "string" && value.id ? value.id : randomUUID(),
    projectId: text("projectId", 200),
    source: value.source,
    key: text("key", 300),
    title: typeof value.title === "string" ? value.title.slice(0, 500) : "",
    url: typeof value.url === "string" ? value.url.slice(0, 2048) : "",
    kind: value.kind,
    targetId: text("targetId", 200),
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : now(),
    writeBack: {
      state: writeBack.state,
      ...(typeof writeBack.code === "string" && writeBack.code
        ? { code: writeBack.code.slice(0, 64) }
        : {}),
    },
  };
}

/**
 * Plane connections (host-scoped tokens in private files), per-project ticket
 * links and the records of started tickets. Tokens never enter the JSON file.
 */
export class TicketStore {
  constructor({ dataDir, now = Date.now }) {
    this.dataDir = dataDir;
    this.now = now;
    this.file = path.join(dataDir, "ticket-sources.json");
    this.secretDir = privateDirectory(path.join(dataDir, "ticket-source-secrets"));
    let saved;
    try {
      saved = readJSON(this.file, {});
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A damaged file starts empty; the unreadable copy is kept for the owner.
      fs.renameSync(this.file, `${this.file}.corrupt-${this.now()}`);
      saved = {};
    }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
    this.connections = Array.isArray(saved.connections) ? saved.connections : [];
    this.projects = Array.isArray(saved.projects) ? saved.projects : [];
    this.startRecords = Array.isArray(saved.starts) ? saved.starts : [];
  }
  save() {
    writePrivate(this.file, {
      version: 1,
      connections: this.connections,
      projects: this.projects,
      starts: this.startRecords,
    });
  }
  secretFile(id) {
    if (typeof id !== "string" || !connectionId.test(id))
      throw problem(serverMessages.tickets.connectionNotFound, 404);
    return path.join(this.secretDir, `${id}.json`);
  }
  publicConnection(item) {
    return {
      id: item.id,
      kind: "plane",
      name: item.name,
      baseUrl: item.baseUrl,
      workspaceSlug: item.workspaceSlug,
      hasSecret: this.token(item.id) !== null,
      createdAt: item.createdAt,
    };
  }
  listConnections() {
    return this.connections.map((item) => this.publicConnection(item));
  }
  find(id) {
    const item = this.connections.find((entry) => entry.id === id);
    if (!item) throw problem(serverMessages.tickets.connectionNotFound, 404);
    return item;
  }
  connection(id) {
    return this.publicConnection(this.find(id));
  }
  createConnection({ name, baseUrl, workspaceSlug, token } = {}) {
    const checked = {
      name: nameValue(name),
      baseUrl: baseUrlValue(baseUrl),
      workspaceSlug: slugValue(workspaceSlug),
    };
    const secret = tokenValue(token);
    if (!secret) throw problem(serverMessages.tickets.tokenRequired);
    const item = { id: randomUUID(), ...checked, createdAt: this.now() };
    writePrivate(this.secretFile(item.id), { token: secret });
    this.connections.push(item);
    try {
      this.save();
    } catch (error) {
      this.connections.pop();
      fs.rmSync(this.secretFile(item.id), { force: true });
      throw error;
    }
    return this.publicConnection(item);
  }
  updateConnection(id, { name, baseUrl, workspaceSlug, token } = {}) {
    const item = this.find(id);
    const next = {
      name: name === undefined ? item.name : nameValue(name),
      baseUrl: baseUrl === undefined ? item.baseUrl : baseUrlValue(baseUrl),
      workspaceSlug:
        workspaceSlug === undefined ? item.workspaceSlug : slugValue(workspaceSlug),
    };
    const secret = token === undefined || token === null ? "" : tokenValue(token);
    if (secret) writePrivate(this.secretFile(id), { token: secret });
    Object.assign(item, next);
    this.save();
    return this.publicConnection(item);
  }
  removeConnection(id) {
    const item = this.find(id);
    if (this.projects.some((link) => link.plane?.connectionId === id))
      throw problem(serverMessages.tickets.connectionInUse, 409);
    this.connections = this.connections.filter((entry) => entry !== item);
    this.save();
    fs.rmSync(this.secretFile(id), { force: true });
  }
  /** Server-internal: the saved token of one connection, never routed. */
  token(id) {
    if (typeof id !== "string" || !connectionId.test(id)) return null;
    const saved = readJSON(this.secretFile(id), null);
    return typeof saved?.token === "string" && saved.token ? saved.token : null;
  }
  projectLink(projectId) {
    const link = this.projects.find((entry) => entry.projectId === projectId);
    return {
      projectId,
      repoPath: link?.repoPath ?? null,
      plane: link?.plane ?? null,
      github: { inProgressLabel: link?.github?.inProgressLabel || DEFAULT_LABEL },
    };
  }
  setProjectLink(projectId, repoPath, { plane, github } = {}) {
    if (typeof projectId !== "string" || !projectId)
      throw problem(serverMessages.tickets.invalidLink);
    if (typeof repoPath !== "string" || !repoPath || /\x00/.test(repoPath))
      throw problem(serverMessages.tickets.invalidLink);
    const checkedPlane = planeLink(plane);
    if (checkedPlane) this.find(checkedPlane.connectionId);
    const label =
      github?.inProgressLabel === undefined
        ? DEFAULT_LABEL
        : labelValue(github.inProgressLabel);
    const link = {
      projectId,
      repoPath,
      plane: checkedPlane,
      github: { inProgressLabel: label },
    };
    this.projects = [...this.projects.filter((e) => e.projectId !== projectId), link];
    this.save();
    return this.projectLink(projectId);
  }
  starts(projectId) {
    return this.startRecords
      .filter((record) => record.projectId === projectId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }
  findStart(projectId, source, key) {
    return this.starts(projectId).find((r) => r.source === source && r.key === key);
  }
  addStart(record) {
    const saved = startRecord(record, this.now);
    this.startRecords.push(saved);
    if (this.startRecords.length > MAX_STARTS)
      this.startRecords = [...this.startRecords]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_STARTS);
    this.save();
    return saved;
  }
  patchStart(id, patch = {}) {
    const index = this.startRecords.findIndex((record) => record.id === id);
    if (index < 0) throw problem(serverMessages.tickets.startNotFound, 404);
    const current = this.startRecords[index];
    const next = startRecord(
      {
        ...current,
        writeBack: patch.writeBack ?? current.writeBack,
        title: patch.title ?? current.title,
        targetId: patch.targetId ?? current.targetId,
      },
      this.now,
    );
    this.startRecords[index] = next;
    this.save();
    return next;
  }
}
