import { randomUUID } from "node:crypto";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { privateDatabase } from "../../lib/private-database.js";
import { problem } from "../../lib/storage.js";
import { auditActor } from "../audit/audit-actor.js";

const schema = `
CREATE TABLE IF NOT EXISTS secrets(
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '', project_id TEXT,
  value TEXT NOT NULL, updated_at INTEGER NOT NULL);`;
const namePattern = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const MAX_SECRETS = 200;
const MAX_DESCRIPTION = 200;
const MAX_VALUE_BYTES = 8192;

const fail = (message, status, code) => Object.assign(problem(message, status), { code });
const invalid = (message) => fail(message, 400, "SECRET_INVALID");

function cleanName(value) {
  if (typeof value !== "string" || !namePattern.test(value))
    throw invalid(serverMessages.secrets.invalidName);
  return value;
}
function cleanDescription(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > MAX_DESCRIPTION)
    throw invalid(serverMessages.secrets.invalidDescription);
  return value;
}
function cleanProject(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 120)
    throw invalid(serverMessages.secrets.invalidProject);
  return value;
}
function cleanValue(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    Buffer.byteLength(value) > MAX_VALUE_BYTES
  )
    throw invalid(serverMessages.secrets.invalidValue);
  return value;
}

/** Secrets the owner delivers to agents and sessions; values leave only via `entries()`. */
export class SecretStore {
  constructor({ dataDir, audit, clock = Date.now } = {}) {
    this.audit = audit;
    this.clock = clock;
    this.listeners = new Set();
    this.db = privateDatabase(path.join(dataDir, "secrets"), "secrets.sqlite");
    this.db.exec(schema);
  }
  /** Calls `listener()` after every change; returns the unsubscribe function. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  changed() {
    for (const listener of [...this.listeners])
      try {
        listener();
      } catch {
        // One failing subscriber must not hide the change from the others.
      }
  }
  record(action, row, actor, changed) {
    this.audit?.append({
      action,
      resourceType: "secret",
      resourceId: row.id,
      source: "user",
      outcome: "success",
      ...auditActor(actor),
      details: { name: row.name, ...(changed ? { changed } : {}) },
    });
  }
  publicSecret(row) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      projectId: row.project_id,
      updatedAt: row.updated_at,
      hasValue: true,
    };
  }
  row(id) {
    const row = this.db.prepare("SELECT * FROM secrets WHERE id=?").get(id);
    if (!row) throw fail(serverMessages.secrets.notFound, 404, "SECRET_NOT_FOUND");
    return row;
  }
  nameTaken(name, exceptId) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM secrets WHERE name=? AND id IS NOT ?")
        .get(name, exceptId ?? null),
    );
  }
  list() {
    return this.db
      .prepare(
        "SELECT id,name,description,project_id,updated_at FROM secrets ORDER BY name",
      )
      .all()
      .map((row) => this.publicSecret(row));
  }
  /** `{ id, name }` of every secret, sorted by name; never reads a value. */
  names() {
    return this.db
      .prepare("SELECT id,name FROM secrets ORDER BY name")
      .all()
      .map(({ id, name }) => ({ id, name }));
  }
  get(id) {
    return this.publicSecret(this.row(id));
  }
  create(input, actor) {
    const name = cleanName(input?.name);
    const description = cleanDescription(input?.description);
    const projectId = cleanProject(input?.projectId);
    const value = cleanValue(input?.value);
    if (this.nameTaken(name))
      throw fail(serverMessages.secrets.nameTaken, 409, "SECRET_NAME_TAKEN");
    if (this.db.prepare("SELECT COUNT(*) AS n FROM secrets").get().n >= MAX_SECRETS)
      throw fail(serverMessages.secrets.limit, 409, "SECRET_LIMIT");
    const row = {
      id: randomUUID(),
      name,
      description,
      project_id: projectId,
      value,
      updated_at: this.clock(),
    };
    this.db
      .prepare(
        "INSERT INTO secrets(id,name,description,project_id,value,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(row.id, name, description, projectId, value, row.updated_at);
    this.record("secret.created", row, actor);
    this.changed();
    return this.publicSecret(row);
  }
  update(id, input, actor) {
    const old = this.row(id);
    const name = input?.name === undefined ? old.name : cleanName(input.name);
    const description =
      input?.description === undefined
        ? old.description
        : cleanDescription(input.description);
    const projectId =
      input?.projectId === undefined ? old.project_id : cleanProject(input.projectId);
    const value = input?.value === undefined ? old.value : cleanValue(input.value);
    if (name !== old.name && this.nameTaken(name, id))
      throw fail(serverMessages.secrets.nameTaken, 409, "SECRET_NAME_TAKEN");
    const changed = [];
    if (name !== old.name) changed.push("name");
    if (description !== old.description) changed.push("description");
    if (projectId !== old.project_id) changed.push("project");
    if (value !== old.value) changed.push("value");
    const row = { ...old, name, description, project_id: projectId, value };
    if (changed.length) row.updated_at = this.clock();
    this.db
      .prepare(
        "UPDATE secrets SET name=?, description=?, project_id=?, value=?, updated_at=? WHERE id=?",
      )
      .run(name, description, projectId, value, row.updated_at, id);
    if (changed.length) {
      this.record("secret.updated", row, actor, changed);
      this.changed();
    }
    return this.publicSecret(row);
  }
  remove(id, actor) {
    const row = this.row(id);
    this.db.prepare("DELETE FROM secrets WHERE id=?").run(id);
    this.record("secret.deleted", row, actor);
    this.changed();
  }
  /** `{ name, value }` of the known ids, in the order given; unknown ids are skipped. */
  entries(ids) {
    const select = this.db.prepare("SELECT name,value FROM secrets WHERE id=?");
    return [...new Set(ids)].flatMap((id) => {
      const row = select.get(id);
      return row ? [{ name: row.name, value: row.value }] : [];
    });
  }
  projectEntries(projectId) {
    return this.db
      .prepare("SELECT id,name,value FROM secrets WHERE project_id=? ORDER BY name")
      .all(projectId)
      .map(({ id, name, value }) => ({ id, name, value }));
  }
  /** A merged project's secrets follow it to the project it moved into. */
  moveProject(fromId, toId) {
    const result = this.db
      .prepare("UPDATE secrets SET project_id=? WHERE project_id=?")
      .run(toId, fromId);
    if (result.changes) this.changed();
  }
  /** Every secret with its value, for the sealed (credential) backup only. */
  exportSealed() {
    return {
      version: 1,
      secrets: this.db
        .prepare("SELECT id,name,description,project_id,value FROM secrets ORDER BY name")
        .all()
        .map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          projectId: r.project_id,
          value: r.value,
        })),
    };
  }
}
