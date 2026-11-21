import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";
import { problem } from "../../lib/storage.js";
import { isConfigFile } from "../assistants/backup-credentials.js";
import { relocatePaths } from "../../lib/relocate-paths.js";

/**
 * Absolute paths below assistants/ in the Gateway's JSON files are stored relative to
 * this marker and resolved against the restored data directory. A rewritten path that
 * would leave the restored assistants/ folder rejects the restore.
 */
export const rootMarker = "$AGENTPIER_ASSISTANTS";
const invalid = () => problem(serverMessages.backups.invalidManifest);

// The Gateway configuration with OpenClaw's copies of it, and OpenClaw's legacy
// per-agent session index, whose entries may name transcripts by absolute path (see
// docs/assistant-runtime-updates.md).
const sessionIndex = /^state\/agents\/[^/]+\/sessions\/sessions\.json$/;
export const isRelocatable = (relative) =>
  isConfigFile(relative) || sessionIndex.test(relative);

// A rewritten path must stay inside the restored assistants/ folder.
const inside = (to) => (rewritten) => {
  const resolved = path.resolve(rewritten);
  if (resolved !== to && !resolved.startsWith(`${to}${path.sep}`)) throw invalid();
};

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
  return JSON.stringify(relocatePaths(value, root, rootMarker), null, 2);
}

/** Resolves the marker to `root`; malformed JSON or an escaping path is invalid. */
export function restoredText(text, root) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid();
  }
  const to = path.resolve(root);
  return JSON.stringify(relocatePaths(value, rootMarker, to, inside(to)), null, 2);
}
