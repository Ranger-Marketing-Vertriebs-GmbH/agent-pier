import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import {
  MAX_SECRETS,
  SecretStore,
  restoredSecret,
  secretsRestoreFile,
} from "./secret-store.js";

/**
 * Secrets in backups (docs/backups.md): names, descriptions, projects and values travel
 * only in the passphrase-sealed credentials capsule; ordinary backups leave them out.
 * Nothing else below `<data>/secrets/` (the database itself, delivered session files)
 * is ever archived.
 */
export const secretsMember = "secrets/secrets.json";
export const secretsOmission =
  "Secrets (only in backups with a passphrase, then encrypted)";
export { secretsRestoreFile };

function openStore(dataDir) {
  // Never creates a store: a data folder without one holds no secrets.
  if (!fs.existsSync(path.join(dataDir, "secrets", "secrets.sqlite"))) return null;
  return new SecretStore({ dataDir });
}

/**
 * Whether this data folder holds at least one secret; never reads a value. A store
 * that cannot be opened counts as present, so the plan never hides it.
 */
export function secretsPresent(dataDir) {
  let store;
  try {
    store = openStore(dataDir);
    return Boolean(store?.names().length);
  } catch {
    return true;
  } finally {
    store?.close();
  }
}

/**
 * Every secret with its value for the capsule, or null without any secret. A store
 * that cannot be read fails the backup instead of leaving the secrets out silently.
 */
export function captureSecrets(dataDir) {
  const store = openStore(dataDir);
  if (!store) return null;
  try {
    const sealed = store.exportSealed();
    return sealed.secrets.length ? sealed : null;
  } finally {
    store.close();
  }
}

/**
 * Prepares the sealed secrets of a restore `stage` for the first start: removes the
 * capsule member, maps each secret's project through `projectMappings` (an unmapped
 * project leaves the secret without one; those are counted as `withoutProject`) and
 * writes the secrets to `secrets/secrets-restore.json`. Returns null when the backup
 * held no secrets.
 */
export function restoreSecrets(stage, projectMappings = []) {
  const file = path.join(stage, secretsMember);
  if (!fs.existsSync(file)) return null;
  let value;
  try {
    value = readJSON(file, null);
  } catch {
    value = null;
  } finally {
    fs.rmSync(file, { force: true });
  }
  let secrets;
  try {
    if (
      value?.version !== 1 ||
      !Array.isArray(value.secrets) ||
      value.secrets.length > MAX_SECRETS
    )
      throw new Error("invalid");
    secrets = value.secrets.map(restoredSecret);
    for (const key of ["id", "name"])
      if (new Set(secrets.map((row) => row[key])).size !== secrets.length)
        throw new Error("invalid");
  } catch {
    throw problem(serverMessages.backups.unexpectedComponent);
  }
  let withoutProject = 0;
  const mapped = secrets.map((row) => {
    if (row.projectId === null) return row;
    const mapping = projectMappings.find((entry) => entry.from === row.projectId);
    if (!mapping) withoutProject++;
    return { ...row, projectId: mapping ? mapping.to : null };
  });
  writePrivate(path.join(stage, "secrets", secretsRestoreFile), {
    version: 1,
    secrets: mapped,
  });
  return { restored: mapped.length, withoutProject };
}
