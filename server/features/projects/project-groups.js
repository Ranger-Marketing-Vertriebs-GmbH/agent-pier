import { randomBytes } from "node:crypto";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { readJSON, writePrivate } from "../../lib/storage.js";

export const MAX_GROUP_NAME = 60;
export const MAX_GROUPS = 200;
export const MAX_ASSIGNMENTS = 500;

const CODES = Object.freeze({
  PROJECT_GROUP_INVALID: ["invalidDocument", 400],
  PROJECT_GROUP_NAME_INVALID: ["invalidName", 400],
  PROJECT_GROUP_NAME_TAKEN: ["nameTaken", 400],
  PROJECT_GROUP_UNKNOWN: ["unknownGroup", 400],
  PROJECT_GROUP_ASSIGNMENT_INVALID: ["invalidAssignment", 400],
  PROJECT_GROUP_LIMIT: ["tooMany", 400],
  PROJECT_GROUP_CONFLICT: ["conflict", 409],
});

/** An error with a stable `code` and the German message of that code. */
export function groupError(code) {
  const [key, status] = CODES[code];
  return Object.assign(new Error(serverMessages.projectGroups[key]), { code, status });
}

/** Server-side twin of `normalizePath` in web/features/projects/useProjectHub.js. */
export function normalizeProjectPath(value) {
  const text = String(value || "");
  const trimmed = text.replace(/\/+$/, "");
  return trimmed || (text.startsWith("/") ? "/" : "");
}

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nameKey = (name) => name.toLocaleLowerCase();
const validId = (id) => typeof id === "string" && /^g_[a-f0-9]{16}$/.test(id);
const absolute = (key) =>
  typeof key === "string" && path.isAbsolute(normalizeProjectPath(key));

/** A trimmed name of 1 to 60 characters without control characters, else null. */
function cleanName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= MAX_GROUP_NAME && !/[\x00-\x1f\x7f]/.test(name)
    ? name
    : null;
}

/** The safe reading of a stored document: whatever is invalid is dropped. */
export function sanitizeDocument(raw) {
  const document = { version: 0, groups: [], assignments: {} };
  if (!isRecord(raw)) return document;
  if (Number.isSafeInteger(raw.version) && raw.version >= 0)
    document.version = raw.version;
  const ids = new Set(),
    names = new Set();
  for (const group of Array.isArray(raw.groups) ? raw.groups : []) {
    const name = isRecord(group) ? cleanName(group.name) : null;
    if (
      !name ||
      !validId(group.id) ||
      ids.has(group.id) ||
      names.has(nameKey(name)) ||
      document.groups.length >= MAX_GROUPS
    )
      continue;
    ids.add(group.id);
    names.add(nameKey(name));
    document.groups.push({ id: group.id, name });
  }
  if (isRecord(raw.assignments))
    for (const [key, id] of Object.entries(raw.assignments)) {
      if (!absolute(key) || !ids.has(id)) continue;
      if (Object.keys(document.assignments).length >= MAX_ASSIGNMENTS) break;
      document.assignments[normalizeProjectPath(key)] = id;
    }
  return document;
}

/**
 * The project groups of the projects page: user-defined, purely organisational
 * (nothing here touches the file system). One document per data directory, replaced
 * as a whole; `version` rises with every write so a stale writer gets a conflict.
 */
export class ProjectGroups {
  constructor({ dataDir, onChange = () => {} }) {
    this.file = path.join(dataDir, "project-groups.json");
    this.onChange = onChange;
    let saved;
    try {
      saved = readJSON(this.file, undefined);
    } catch {
      saved = undefined;
    }
    this.value = sanitizeDocument(saved);
  }
  /** The current document; assignments to groups that are gone never appear. */
  get() {
    return sanitizeDocument(this.value);
  }
  /**
   * Replaces the document with `body` (`{ version, groups, assignments }`), which must
   * be based on the current version. A group without an id is new and gets one; an id
   * that is not a current group's is refused. Returns the new document.
   */
  replace(body) {
    if (
      !isRecord(body) ||
      Object.keys(body).some(
        (key) => !["version", "groups", "assignments"].includes(key),
      ) ||
      !Number.isSafeInteger(body.version) ||
      !Array.isArray(body.groups) ||
      !isRecord(body.assignments)
    )
      throw groupError("PROJECT_GROUP_INVALID");
    const current = this.get();
    if (body.version !== current.version) throw groupError("PROJECT_GROUP_CONFLICT");
    if (
      body.groups.length > MAX_GROUPS ||
      Object.keys(body.assignments).length > MAX_ASSIGNMENTS
    )
      throw groupError("PROJECT_GROUP_LIMIT");
    const known = new Set(current.groups.map((group) => group.id)),
      used = new Set(),
      names = new Set(),
      groups = [];
    for (const group of body.groups) {
      if (!isRecord(group) || Object.keys(group).some((k) => !["id", "name"].includes(k)))
        throw groupError("PROJECT_GROUP_INVALID");
      const name = cleanName(group.name);
      if (!name) throw groupError("PROJECT_GROUP_NAME_INVALID");
      if (names.has(nameKey(name))) throw groupError("PROJECT_GROUP_NAME_TAKEN");
      names.add(nameKey(name));
      let id = group.id;
      if (id === undefined) {
        do id = `g_${randomBytes(8).toString("hex")}`;
        while (known.has(id) || used.has(id));
      } else if (!known.has(id) || used.has(id))
        throw groupError("PROJECT_GROUP_UNKNOWN");
      used.add(id);
      groups.push({ id, name });
    }
    const assignments = {};
    for (const [key, id] of Object.entries(body.assignments)) {
      if (!absolute(key)) throw groupError("PROJECT_GROUP_ASSIGNMENT_INVALID");
      if (typeof id !== "string" || !used.has(id))
        throw groupError("PROJECT_GROUP_ASSIGNMENT_INVALID");
      assignments[normalizeProjectPath(key)] = id;
    }
    const next = { version: current.version + 1, groups, assignments };
    writePrivate(this.file, next);
    this.value = next;
    this.onChange();
    return this.get();
  }
}
