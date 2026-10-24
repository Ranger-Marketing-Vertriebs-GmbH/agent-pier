import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { nameValue, problem, readJSON, writePrivate } from "../../lib/storage.js";
import { publicKeyValue } from "./ssh-keys.js";
import { hostTuple } from "./ssh-management-records.js";
import { remoteRootValue } from "./sftp-host-fields.js";
import { SshPasswordStore, passwordValue } from "./ssh-password-store.js";

/**
 * SFTP hosts in backups (docs/backups.md): password hosts travel only in the
 * passphrase-sealed credentials capsule, with their passwords; ordinary backups leave
 * them out. Key hosts are left out like SSH hosts and keys.
 */
export const sftpHostsMember = "ssh/sftp-hosts.json";
export const sftpHostsOmission =
  "SFTP hosts and passwords (only in backups with a passphrase, then encrypted)";
/** Hosts a restore left for the first start to add to the SSH catalog. */
export const sftpRestoreFile = "sftp-restore.json";

const identifier = /^[0-9a-f-]{36}$/;
const fields = [
  "id",
  "name",
  "host",
  "port",
  "username",
  "keyId",
  "hostKey",
  "hostFingerprint",
  "createdAt",
  "projectId",
  "trustSource",
  "type",
  "auth",
  "remoteRoot",
  "credentialRevision",
];

function passwordHosts(dataDir) {
  let catalog;
  try {
    catalog = readJSON(path.join(dataDir, "ssh", "catalog.json"), null);
  } catch {
    return [];
  }
  return Array.isArray(catalog?.sftpHosts)
    ? catalog.sftpHosts.filter((row) => row?.type === "sftp" && row.auth === "password")
    : [];
}

/** Whether this data folder holds SFTP hosts that sign in with a password. */
export const sftpHostsPresent = (dataDir) => passwordHosts(dataDir).length > 0;

/**
 * The password SFTP hosts of the published catalog with their current passwords, or
 * null without any. A host whose password cannot be read is left out.
 */
export function captureSftpHosts(dataDir) {
  const store = new SshPasswordStore({ root: path.join(dataDir, "ssh") });
  const hosts = [];
  const passwords = Object.create(null);
  for (const row of passwordHosts(dataDir)) {
    try {
      passwords[row.id] = store.read(row.id, row.credentialRevision);
    } catch {
      continue;
    }
    hosts.push(row);
  }
  return hosts.length ? { hosts, passwords: { ...passwords } } : null;
}

// A row the server would refuse at its start fails the restore instead.
function restoredRow(row, passwords) {
  if (
    !row ||
    typeof row !== "object" ||
    typeof row.id !== "string" ||
    !identifier.test(row.id) ||
    row.type !== "sftp" ||
    row.auth !== "password" ||
    typeof row.credentialRevision !== "string" ||
    !identifier.test(row.credentialRevision) ||
    (row.projectId !== null && typeof row.projectId !== "string") ||
    !Object.hasOwn(passwords, row.id)
  )
    throw new Error("invalid");
  passwordValue(passwords[row.id]);
  nameValue(row.name);
  publicKeyValue(row.hostKey);
  remoteRootValue(row.remoteRoot);
  hostTuple(row);
  return Object.fromEntries(
    fields.filter((name) => row[name] !== undefined).map((name) => [name, row[name]]),
  );
}

/**
 * Prepares the sealed SFTP hosts of a restore `stage` for the first start: removes the
 * capsule member, maps each host's project through `projectMappings` (an unmapped
 * project leaves the host without one; those are counted as `skipped`), writes the
 * passwords to the stage's password store and the hosts to `ssh/sftp-restore.json`.
 * Returns null when the backup held no SFTP hosts.
 */
export function restoreSftpHosts(stage, projectMappings = []) {
  const file = path.join(stage, sftpHostsMember);
  if (!fs.existsSync(file)) return null;
  let value;
  try {
    value = readJSON(file, null);
  } catch {
    value = null;
  } finally {
    fs.rmSync(file, { force: true });
  }
  const passwords =
    value?.passwords && typeof value.passwords === "object" ? value.passwords : {};
  let hosts;
  try {
    if (value?.version !== 1 || !Array.isArray(value.hosts)) throw new Error("invalid");
    hosts = value.hosts.map((row) => restoredRow(row, passwords));
    if (new Set(hosts.map((row) => row.id)).size !== hosts.length)
      throw new Error("invalid");
  } catch {
    throw problem(serverMessages.backups.unexpectedComponent);
  }
  let skipped = 0;
  const mapped = hosts.map((row) => {
    if (row.projectId === null || row.projectId === undefined)
      return { ...row, projectId: null };
    const mapping = projectMappings.find((entry) => entry.from === row.projectId);
    if (!mapping) skipped++;
    return { ...row, projectId: mapping ? mapping.to : null };
  });
  const root = path.join(stage, "ssh");
  const store = new SshPasswordStore({ root });
  // Each password stays pending until the first start adds its host to the catalog.
  for (const row of mapped)
    store.write(row.id, row.credentialRevision, passwords[row.id]);
  writePrivate(path.join(root, sftpRestoreFile), { version: 1, hosts: mapped });
  return { restored: mapped.length, skipped };
}

function tupleOf(row) {
  try {
    return hostTuple(row);
  } catch {
    return null;
  }
}

/**
 * The catalog `current` with the hosts of a restore file added, or null when the file
 * holds none. Hosts whose id or address the catalog already has are left out, so an
 * interrupted import can run again.
 */
export function mergeRestoredSftpHosts(file, current) {
  let value;
  try {
    value = readJSON(file, null);
  } catch {
    return null;
  }
  if (!Array.isArray(value?.hosts)) return null;
  const rows = [...current.keys, ...current.hosts, ...current.sftpHosts];
  const ids = new Set(rows.map((row) => row.id));
  const tuples = new Set(
    [...current.hosts, ...current.sftpHosts].map(tupleOf).filter(Boolean),
  );
  const added = [];
  for (const row of value.hosts) {
    const tuple = tupleOf(row);
    if (
      !tuple ||
      row.type !== "sftp" ||
      !identifier.test(row.id) ||
      ids.has(row.id) ||
      tuples.has(tuple)
    )
      continue;
    ids.add(row.id);
    tuples.add(tuple);
    added.push(row);
  }
  return added.length
    ? { ...current, sftpHosts: [...current.sftpHosts, ...added] }
    : null;
}
