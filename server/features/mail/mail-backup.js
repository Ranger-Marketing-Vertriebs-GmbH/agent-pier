import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { privateDirectory, problem, readJSON, writePrivate } from "../../lib/storage.js";
import { SshPasswordStore } from "../ssh/ssh-password-store.js";
import { accountInput, accountRowKeys } from "./mail-account-fields.js";

/**
 * Email accounts in backups (docs/backups.md): the accounts and their passwords travel
 * only in the passphrase-sealed credentials capsule; ordinary backups hold nothing of
 * `mail/`. Restored accounts keep their ids, so agent grants match them again.
 */
export const mailAccountsMember = "mail/accounts.json";
export const mailAccountsOmission =
  "Email accounts and passwords (only in backups with a passphrase, then encrypted)";
/** Named when the account list itself cannot be read: never left out silently. */
export const mailCatalogUnreadableOmission =
  "Email accounts (their list could not be read)";
/** Accounts a restore left for the first start to add to the mail catalog. */
export const mailRestoreFile = "mail-restore.json";

const identifier = /^[0-9a-f-]{36}$/;
const rowKeys = new Set(accountRowKeys);

// The catalog's rows; `unreadable` when the file exists but is no version 1 catalog.
function catalogState(dataDir) {
  let catalog;
  try {
    catalog = readJSON(path.join(dataDir, mailAccountsMember), null);
  } catch {
    return { rows: [], unreadable: true };
  }
  if (catalog === null) return { rows: [], unreadable: false };
  if (catalog?.version !== 1 || !Array.isArray(catalog.accounts))
    return { rows: [], unreadable: true };
  return {
    rows: catalog.accounts.filter((row) => row && typeof row === "object"),
    unreadable: false,
  };
}
const accountRows = (dataDir) => catalogState(dataDir).rows;

/** Whether the account list of this data folder cannot be read. */
export const mailCatalogUnreadable = (dataDir) => catalogState(dataDir).unreadable;

/**
 * Whether this data folder holds email accounts. An account list that cannot be read
 * counts as present, so a backup never leaves the accounts out silently.
 */
export function mailAccountsPresent(dataDir) {
  const { rows, unreadable } = catalogState(dataDir);
  return unreadable || rows.length > 0;
}

/** The omission of an account whose password could not be read; names only its label. */
export const unreadableMailAccountOmission = (name) =>
  `Email account "${name}" (its password could not be read)`;

/**
 * The accounts of the published catalog with their current passwords, and the
 * omissions of accounts whose password could not be read; null without any account.
 * An account list that cannot be read seals nothing and is named as omitted.
 */
export function captureMailAccounts(dataDir) {
  const { rows, unreadable } = catalogState(dataDir);
  if (unreadable)
    return { accounts: [], passwords: {}, omissions: [mailCatalogUnreadableOmission] };
  if (!rows.length) return null;
  const store = new SshPasswordStore({ root: path.join(dataDir, "mail") });
  const read = (row) => {
    try {
      return store.read(row.id, row.credentialRevision);
    } catch {
      return null;
    }
  };
  const accounts = [];
  const passwords = Object.create(null);
  const omissions = [];
  for (let row of rows) {
    let password = read(row);
    if (password === null) {
      // A password change between the catalog and the password read: read both again.
      row = accountRows(dataDir).find((next) => next.id === row.id);
      if (!row) continue;
      password = read(row);
    }
    if (password === null) {
      omissions.push(unreadableMailAccountOmission(row.name));
      continue;
    }
    passwords[row.id] = password;
    accounts.push(row);
  }
  return { accounts, passwords: { ...passwords }, omissions };
}

const timestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

// A row the server would refuse at its start fails the restore instead.
function restoredRow(row, passwords) {
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).some((key) => !rowKeys.has(key)) ||
    typeof row.id !== "string" ||
    !identifier.test(row.id) ||
    typeof row.credentialRevision !== "string" ||
    !identifier.test(row.credentialRevision) ||
    !timestamp(row.createdAt) ||
    !timestamp(row.updatedAt) ||
    !Object.hasOwn(passwords, row.id)
  )
    throw new Error("invalid");
  const { password: _checked, ...fields } = accountInput({
    name: row.name,
    address: row.address,
    displayName: row.displayName,
    preset: row.preset,
    imap: row.imap,
    smtp: row.smtp,
    allowPlaintext: row.allowPlaintext,
    saveSent: row.saveSent,
    password: passwords[row.id],
  });
  return {
    id: row.id,
    ...fields,
    credentialRevision: row.credentialRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // The restored host has not tested the account yet.
    lastTest: null,
  };
}

/**
 * Prepares the sealed email accounts of a restore `stage` for the first start: removes
 * the capsule member, writes the passwords to the stage's password store (pending until
 * the import) and the accounts to `mail/mail-restore.json`. Every row is checked before
 * anything is written. Returns null when the backup held no email accounts.
 */
export function restoreMailAccounts(stage) {
  const file = path.join(stage, mailAccountsMember);
  if (!fs.existsSync(file)) return null;
  let value;
  try {
    value = readJSON(file, null);
  } catch {
    value = null;
  } finally {
    fs.rmSync(file, { force: true });
  }
  let rows, passwords;
  try {
    if (value?.version !== 1 || !Array.isArray(value.accounts))
      throw new Error("invalid");
    passwords =
      value.passwords && typeof value.passwords === "object" ? value.passwords : {};
    rows = value.accounts.map((row) => restoredRow(row, passwords));
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new Error("invalid");
  } catch {
    throw problem(serverMessages.backups.unexpectedComponent);
  }
  const root = privateDirectory(path.join(stage, "mail"));
  const store = new SshPasswordStore({ root });
  // Each password stays pending until the first start adds its account to the catalog.
  for (const row of rows) store.write(row.id, row.credentialRevision, passwords[row.id]);
  writePrivate(path.join(root, mailRestoreFile), { version: 1, accounts: rows });
  return { restored: rows.length };
}

/**
 * The catalog `current` with the accounts of a restore file added, or null when the
 * file adds none. Accounts whose id the catalog already has are left out, so an
 * existing account is never overwritten and an interrupted import can run again.
 */
export function mergeRestoredMailAccounts(file, current) {
  let value;
  try {
    value = readJSON(file, null);
  } catch {
    return null;
  }
  if (!Array.isArray(value?.accounts)) return null;
  const ids = new Set(current.accounts.map((row) => row.id));
  const added = [];
  for (const row of value.accounts) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.id !== "string" ||
      !identifier.test(row.id) ||
      typeof row.credentialRevision !== "string" ||
      !identifier.test(row.credentialRevision) ||
      ids.has(row.id)
    )
      continue;
    ids.add(row.id);
    added.push(row);
  }
  return added.length ? { ...current, accounts: [...current.accounts, ...added] } : null;
}
