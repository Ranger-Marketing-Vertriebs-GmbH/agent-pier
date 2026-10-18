import { randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { contentHash, scanSkill, visibleText } from "./skill-scan.js";

export const PREVIEW_TTL = 10 * 60 * 1000;
// Previews keep the scanned files, so the install writes exactly what was shown.
const PREVIEW_LIMIT = 8;
const PREVIEW_BYTES = 64 * 1024 * 1024;

const sizeOf = (files) => files.reduce((sum, [, data]) => sum + data.length, 0);

/**
 * Skill import previews: the unpacked files of one upload or GitHub download, their
 * scan and content hash. A preview is confirmed once, by the profile it was made
 * for, before it expires and only with the hash it showed; warnings need an explicit
 * acceptance and blocking findings an override naming each blocking rule.
 */
export class SkillPreviews {
  constructor({ ttl = PREVIEW_TTL, now = Date.now } = {}) {
    this.ttl = ttl;
    this.now = now;
    this.items = new Map();
  }
  /** Scans `pack` for profile `accountId` and keeps it as a new preview. */
  create(accountId, pack, importKind) {
    this.prune();
    const scan = scanSkill(pack.files);
    const entry = {
      previewId: randomUUID(),
      accountId,
      pack,
      importKind,
      scan,
      hash: contentHash(pack.files),
      size: sizeOf(pack.files),
      expires: this.now() + this.ttl,
    };
    this.items.set(entry.previewId, entry);
    this.prune();
    return publicPreview(entry);
  }
  /** Drops expired previews, then the oldest beyond the count and size limits. */
  prune() {
    const now = this.now();
    for (const [id, entry] of this.items) if (entry.expires < now) this.items.delete(id);
    let bytes = [...this.items.values()].reduce((sum, entry) => sum + entry.size, 0);
    for (const [id, entry] of this.items) {
      if (this.items.size <= PREVIEW_LIMIT && bytes <= PREVIEW_BYTES) break;
      this.items.delete(id);
      bytes -= entry.size;
    }
  }
  /**
   * Takes the preview `input.previewId` of `accountId` once, after checking the
   * owner's decision; a refused decision leaves the preview for another attempt.
   */
  take(accountId, input = {}) {
    if (typeof input.previewId !== "string")
      throw problem(serverMessages.extensions.skillPreviewRequired, 409);
    const entry = this.items.get(input.previewId);
    if (entry && entry.expires < this.now()) this.items.delete(input.previewId);
    if (!entry || entry.accountId !== accountId || entry.expires < this.now())
      throw problem(serverMessages.extensions.skillPreviewExpired, 409);
    if (input.contentHash !== entry.hash)
      throw problem(serverMessages.extensions.skillPreviewChanged, 409);
    const { verdict, blocking } = entry.scan;
    const named = Array.isArray(input.override?.rules) ? input.override.rules : [];
    const overridden =
      verdict === "block" &&
      named.length === blocking.length &&
      blocking.every((rule) => named.includes(rule));
    if (verdict === "block" && !overridden)
      throw problem(serverMessages.extensions.skillScanBlocked, 409);
    if (verdict === "warn" && input.acceptWarnings !== true)
      throw problem(serverMessages.extensions.skillWarningsNotAccepted, 409);
    this.items.delete(entry.previewId);
    return { ...entry, overridden };
  }
  /** Puts a taken preview back when its install failed, unless it expired meanwhile. */
  restore(entry) {
    if (entry.expires >= this.now()) this.items.set(entry.previewId, entry);
  }
  clear() {
    this.items.clear();
  }
}

/** What the owner sees: identity, files, verdict and findings; never file contents. */
export function publicPreview(entry) {
  const { pack, scan } = entry;
  return {
    previewId: entry.previewId,
    contentHash: entry.hash,
    expiresAt: new Date(entry.expires).toISOString(),
    importKind: entry.importKind,
    name: pack.name,
    description: pack.description,
    ...(pack.origin ? { origin: pack.origin } : {}),
    size: entry.size,
    files: pack.files.map(([name, data, mode = 0o600]) => ({
      name: visibleText(name),
      size: data.length,
      executable: Boolean(mode & 0o111),
    })),
    verdict: scan.verdict,
    rules: scan.rules,
    blocking: scan.blocking,
    findings: scan.findings,
    truncated: scan.truncated,
  };
}
