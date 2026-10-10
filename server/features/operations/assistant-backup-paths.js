import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";
import { problem } from "../../lib/storage.js";
import { configPath } from "../assistants/backup-credentials.js";

/**
 * Absolute paths below assistants/ in the Gateway's JSON files are stored relative to
 * this marker and resolved against the restored data directory. A rewritten path that
 * would leave the restored assistants/ folder rejects the restore.
 */
export const rootMarker = "$AGENTPIER_ASSISTANTS";
const invalid = () => problem(serverMessages.backups.invalidManifest);

// The Gateway configuration and OpenClaw's legacy per-agent session index, whose
// entries may name transcripts by absolute path (see docs/assistant-runtime-updates.md).
const sessionIndex = /^state\/agents\/[^/]+\/sessions\/sessions\.json$/;
export const isRelocatable = (relative) =>
  relative === configPath || sessionIndex.test(relative);

function relocate(value, from, to, contained) {
  if (typeof value === "string") {
    if (value !== from && !value.startsWith(`${from}/`)) return value;
    const rewritten = to + value.slice(from.length);
    if (contained) {
      const resolved = path.resolve(rewritten);
      if (resolved !== to && !resolved.startsWith(`${to}${path.sep}`)) throw invalid();
    }
    return rewritten;
  }
  if (Array.isArray(value))
    return value.map((item) => relocate(item, from, to, contained));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      name,
      relocate(item, from, to, contained),
    ]),
  );
}

/**
 * Replaces the live root by the marker. Returns null for unreadable JSON, which the
 * capture leaves out: a restore rejects it, so keeping it would lock the archive.
 */
export function portableText(text, root) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return JSON.stringify(relocate(value, root, rootMarker, false), null, 2);
}

/** Resolves the marker to `root`; malformed JSON or an escaping path is invalid. */
export function restoredText(text, root) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid();
  }
  return JSON.stringify(relocate(value, rootMarker, path.resolve(root), true), null, 2);
}
