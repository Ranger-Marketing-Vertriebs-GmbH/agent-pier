import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { problem } from "../../lib/storage.js";
import { PRODUCED_TMUX_NAME } from "../sessions/tmux-naming.js";
export function dataSchemaVersion(dataDir) {
  let version = 1;
  for (const name of [
    "memory/memory.sqlite",
    "pipeline-runs/runs.sqlite",
    "audit/audit.sqlite",
    "notifications/notifications.sqlite",
  ]) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw problem(serverMessages.releases.schemaUnverifiable, 409);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      version = Math.max(version, db.prepare("PRAGMA user_version").get().user_version);
    } finally {
      db.close();
    }
  }
  return version;
}
export function requireDataCompatibility(manifest, dataDir) {
  const version = dataSchemaVersion(dataDir);
  if (manifest.schemaMin > version || manifest.schemaMax < version)
    throw problem(serverMessages.releases.schemaUnreadable, 409);
}
/**
 * Refuses a release that does not understand the tmux session names this release
 * produces: it would lose every session started since the update. A manifest check
 * only; release.json lists the understood forms in `tmuxNames` (sessions/tmux-naming.js).
 */
export function requireTmuxNames(manifest) {
  if (
    !Array.isArray(manifest?.tmuxNames) ||
    !manifest.tmuxNames.includes(PRODUCED_TMUX_NAME)
  )
    throw problem(serverMessages.releases.tmuxNamesUnsupported, 409);
}
