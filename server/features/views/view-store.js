import { randomBytes } from "node:crypto";
import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import {
  MAX_VIEWS,
  checkLayout,
  cleanViewName,
  onlyKeys,
  viewError,
} from "./view-layout.js";

export { viewError };

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validId = (id) => typeof id === "string" && /^v_[a-f0-9]{16}$/.test(id);

/** The safe reading of a stored view, or null when anything about it is invalid. */
function cleanView(raw) {
  if (!isRecord(raw) || !validId(raw.id)) return null;
  const name = cleanViewName(raw.name);
  if (!name) return null;
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) return null;
  if (typeof raw.createdAt !== "string" || typeof raw.usedAt !== "string") return null;
  try {
    const layout = checkLayout(raw.layout ?? null);
    return {
      id: raw.id,
      name,
      layout,
      revision: raw.revision,
      createdAt: raw.createdAt,
      usedAt: raw.usedAt,
    };
  } catch {
    return null;
  }
}

/** The safe reading of a stored document: whatever is invalid is dropped. */
export function sanitizeViews(raw) {
  const document = { version: 0, views: [] };
  if (!isRecord(raw)) return document;
  if (Number.isSafeInteger(raw.version) && raw.version >= 0)
    document.version = raw.version;
  const ids = new Set();
  for (const item of Array.isArray(raw.views) ? raw.views : []) {
    const view = cleanView(item);
    if (!view || ids.has(view.id) || document.views.length >= MAX_VIEWS) continue;
    ids.add(view.id);
    document.views.push(view);
  }
  return document;
}

/**
 * The owner's split views: named layouts of sessions and agent chats, one document per
 * data directory. `version` counts the writes; `revision` counts those of one view.
 */
export class ViewStore {
  constructor({ dataDir, onChange = () => {}, now = () => new Date().toISOString() }) {
    this.file = path.join(dataDir, "views.json");
    this.onChange = onChange;
    this.now = now;
    let saved;
    try {
      saved = readJSON(this.file, undefined);
    } catch {
      saved = undefined;
    }
    this.value = sanitizeViews(saved);
  }
  /** The current document (a copy). */
  list() {
    return structuredClone(this.value);
  }
  /** Writes `views` as the next version, then tells the listeners. */
  #save(views) {
    const next = { version: this.value.version + 1, views };
    writePrivate(this.file, next);
    this.value = next;
    this.onChange();
    return next.version;
  }
  create(body) {
    if (!isRecord(body) || !onlyKeys(body, ["name", "layout"]))
      throw viewError("VIEW_INVALID");
    const name = cleanViewName(body.name);
    if (!name) throw viewError("VIEW_NAME_INVALID");
    const layout = checkLayout(body.layout ?? null);
    if (this.value.views.length >= MAX_VIEWS) throw viewError("VIEW_LIMIT");
    const at = this.now();
    let id;
    do id = `v_${randomBytes(8).toString("hex")}`;
    while (this.value.views.some((view) => view.id === id));
    const view = { id, name, layout, revision: 1, createdAt: at, usedAt: at };
    const version = this.#save([...this.value.views, view]);
    return { version, view: structuredClone(view) };
  }
  update(id, body) {
    if (
      !isRecord(body) ||
      !onlyKeys(body, ["name", "layout", "used"]) ||
      !Object.keys(body).length ||
      (body.used !== undefined && body.used !== true)
    )
      throw viewError("VIEW_INVALID");
    const name = body.name === undefined ? undefined : cleanViewName(body.name);
    if (body.name !== undefined && !name) throw viewError("VIEW_NAME_INVALID");
    const layout = body.layout === undefined ? undefined : checkLayout(body.layout);
    const current = this.value.views.find((view) => view.id === id);
    if (!current) throw viewError("VIEW_UNKNOWN");
    const view = {
      ...current,
      ...(name === undefined ? {} : { name }),
      ...(layout === undefined ? {} : { layout }),
      ...(body.used ? { usedAt: this.now() } : {}),
      revision: current.revision + 1,
    };
    const version = this.#save(this.value.views.map((v) => (v === current ? view : v)));
    return { version, view: structuredClone(view) };
  }
  remove(id) {
    if (!this.value.views.some((view) => view.id === id)) throw viewError("VIEW_UNKNOWN");
    return { version: this.#save(this.value.views.filter((view) => view.id !== id)) };
  }
}
