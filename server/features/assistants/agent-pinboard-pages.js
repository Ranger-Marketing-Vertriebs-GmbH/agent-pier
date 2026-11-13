import { randomBytes } from "node:crypto";
import path from "node:path";
import { assistantProblem } from "./assistant-validation.js";
import { MAX_ATTACHMENT_BYTES } from "./agent-attachment-types.js";
import { pinType } from "./agent-pinboard-files.js";

/**
 * A pinned HTML page (kind "page") is shown in the reader inside a frame sandboxed
 * without scripts, same origin, forms, popups or top navigation. The frame's origin is
 * opaque, so its requests carry no session cookie (SameSite=Strict) and count as
 * cross-site: the page and the files it uses come from
 * `/api/pinboard-pages/<grant>/<path below the page's folder>`, where the grant is an
 * unguessable capability for one entry, issued to a signed-in owner session
 * (assistant-pinboard.js) and checked against that session again on every request
 * (pinboard-pages.js). Relative links resolve below the grant, so they stay inside the
 * page's folder; every file is opened with the pinned file's share rules.
 */
export const PAGE_GRANT = /^[A-Za-z0-9_-]{43}$/;
/** The paths authorizeRequest lets a sandboxed frame reach (security.js). */
export const pinboardPagePath = /^\/api\/pinboard-pages\/[A-Za-z0-9_-]{43}\/[^/]/;
/**
 * Every page response: no script, no connection, no frame, no form, no base; images,
 * styles, fonts and media from the page's own grant only. `sandbox` also holds for a
 * file opened outside the reader's frame.
 */
export const PAGE_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' data:; media-src 'self'; frame-ancestors 'self'; " +
  "form-action 'none'; base-uri 'none'; sandbox";

const IDLE_MS = 30 * 60_000;
const LIFETIME_MS = 8 * 60 * 60_000;
const MAX_GRANTS = 256;
const MAX_DEPTH = 32;

/**
 * The page grants, in memory: a grant lapses after 30 idle minutes, 8 hours, a restart
 * or when 256 newer ones exist. `resolve` refreshes the idle time.
 */
export class PinboardPageGrants {
  #grants = new Map();
  constructor({
    now = Date.now,
    idleMs = IDLE_MS,
    lifetimeMs = LIFETIME_MS,
    max = MAX_GRANTS,
  } = {}) {
    Object.assign(this, { now, idleMs, lifetimeMs, max });
  }
  #expired(grant, at) {
    return at - grant.used > this.idleMs || at - grant.issued > this.lifetimeMs;
  }
  /** `{ assistantId, entryId, session }` → the grant's token. */
  issue(grant) {
    const at = this.now();
    for (const [token, held] of this.#grants)
      if (this.#expired(held, at)) this.#grants.delete(token);
    const token = randomBytes(32).toString("base64url");
    this.#grants.set(token, { ...grant, issued: at, used: at });
    while (this.#grants.size > this.max)
      this.#grants.delete(this.#grants.keys().next().value);
    return token;
  }
  resolve(token) {
    if (typeof token !== "string" || !PAGE_GRANT.test(token)) return null;
    const grant = this.#grants.get(token);
    if (!grant) return null;
    const at = this.now();
    if (this.#expired(grant, at)) {
      this.#grants.delete(token);
      return null;
    }
    grant.used = at;
    return grant;
  }
}

/**
 * The file a page asks for, below the folder of the pinned page `pagePath`:
 * `segments` are the request's path segments after the grant, still URL-encoded. No
 * empty, `.`/`..` or hidden segment, no slash or control character once decoded.
 * Returns the path relative to the pin's root, or null.
 */
export function pageFilePath(pagePath, segments) {
  if (!segments.length || segments.length > MAX_DEPTH) return null;
  const parts = [];
  for (const segment of segments) {
    let part;
    try {
      part = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!part || part.startsWith(".") || /[/\\\u0000-\u001f\u007f]/.test(part))
      return null;
    parts.push(part);
  }
  const folder = path.posix.dirname(pagePath);
  return folder === "." ? parts.join("/") : `${folder}/${parts.join("/")}`;
}

// Styles and fonts by name; images (PNG, JPEG, GIF, WebP: never SVG, a document that
// may carry script), video, audio and HTML pages by their bytes (pinType).
const named = {
  css: "text/css; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};
const sniffed = new Set(["image", "video", "audio"]);

/** The type a page file is served as, or null when pages may not use it. */
export async function pageFileType(handle, size, name) {
  const extension = path.extname(name).slice(1).toLowerCase();
  if (Object.hasOwn(named, extension))
    return size <= MAX_ATTACHMENT_BYTES
      ? { type: named[extension], font: extension !== "css" }
      : null;
  const shown = await pinType(handle, size, name);
  if (shown.kind === "page") return { type: "text/html; charset=utf-8", font: false };
  return sniffed.has(shown.kind) ? { type: shown.type, font: false } : null;
}

/**
 * The files of pinned pages for the page route (pinboard-pages.js), opened through
 * the pinboard view (agent-pinboard-view.js) with the entry's own share rules.
 */
export class AgentPinboardPages {
  constructor({ assistants, viewer }) {
    Object.assign(this, { assistants, viewer });
    this.grants = new PinboardPageGrants();
  }

  // The entry while it is a readable page, or pinboardUnavailable.
  async page(assistantId, entryId) {
    const { opened, entry } = await this.viewer.opened(assistantId, entryId);
    await opened.handle.close();
    if (entry.identity?.kind !== "page")
      throw assistantProblem("pinboardUnavailable", 404);
    return entry;
  }

  /** A grant's first URL: the page itself below its grant. */
  async issue(assistantId, entryId, session) {
    const entry = await this.page(assistantId, entryId);
    const token = this.grants.issue({ assistantId, entryId, session });
    return `/api/pinboard-pages/${token}/${encodeURIComponent(path.posix.basename(entry.path))}`;
  }

  /**
   * The file `segments` names below the page's folder, open, with its type; the
   * caller closes `handle`. Anything that is not there, not allowed or fails the
   * share rules is pinboardUnavailable.
   */
  async file(assistantId, entryId, segments) {
    const entry = await this.page(assistantId, entryId);
    const relative = pageFilePath(entry.path, segments);
    if (!relative) throw assistantProblem("pinboardUnavailable", 404);
    const agent = this.assistants.store.getAssistant(assistantId);
    let opened;
    try {
      opened = await this.viewer.open(agent, { ...entry, path: relative });
    } catch {
      throw assistantProblem("pinboardUnavailable", 404);
    }
    try {
      const type = await pageFileType(opened.handle, opened.size, opened.name);
      if (!type) throw assistantProblem("pinboardUnavailable", 404);
      return { ...type, handle: opened.handle, size: opened.size };
    } catch (error) {
      await opened.handle.close();
      throw error;
    }
  }
}
