import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { problem } from "../../lib/storage.js";
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
      throw problem("Cannot verify data schema safely.", 409);
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
    throw problem(
      "Release cannot read the current data schema; rollback would require a separate fresh-target restore.",
      409,
    );
}
