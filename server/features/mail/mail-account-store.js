import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { privateDirectory, problem, readJSON, writePrivate } from "../../lib/storage.js";
import { auditActor } from "../audit/audit-actor.js";
import { SshPasswordStore } from "../ssh/ssh-password-store.js";
import { accountInput } from "./mail-account-fields.js";
import { mailRestoreFile, mergeRestoredMailAccounts } from "./mail-backup.js";
import { smtpSend, testMailAccount, withImap } from "./mail-connection.js";
import { MailTextCache } from "./mail-text-cache.js";

const VERSION = 1;
// Field names in the order an update audit lists them.
const fieldNames = [
  "name",
  "address",
  "displayName",
  "preset",
  "imap",
  "smtp",
  "allowPlaintext",
  "saveSent",
];

const mailPasswordMessages = {
  notFound: serverMessages.mail.accountNotFound,
  unavailable: serverMessages.mail.passwordUnavailable,
  invalid: serverMessages.mail.invalidPassword,
};

const resultCode = (side) => (side?.ok ? "ok" : side?.code);

/**
 * Agents' email accounts: `mail/accounts.json` holds the non-secret fields, each
 * password lives in its own 0600 file `mail/passwords/<accountId>/<revision>` (the
 * SFTP password store). A password is written before the catalog commit and settled
 * after it, so startup can drop a crashed write. Passwords stay in this process: they
 * never reach a view, an audit record, a log or an error.
 */
export class MailAccountStore {
  constructor({
    dataDir,
    audit,
    tlsCa = undefined,
    connect = { testMailAccount, withImap, smtpSend },
  }) {
    this.root = path.join(path.resolve(dataDir), "mail");
    this.file = path.join(this.root, "accounts.json");
    this.audit = audit;
    this.tlsCa = tlsCa;
    this.connect = connect;
    this.passwords = new SshPasswordStore({
      root: this.root,
      messages: mailPasswordMessages,
    });
    // Extracted attachment text per account (the attachment-text search); under the
    // data folder, never in a backup, removed with its account.
    this.textCache = new MailTextCache({
      root: path.join(this.root, "text-cache"),
      identity: (id) => {
        try {
          return mailboxIdentity(this.row(id));
        } catch {
          return null;
        }
      },
    });
    /** Called with an account id before the account is removed (grants, cards). */
    this.onRemoved = null;
    this.ready = Promise.resolve().then(() => this.recover());
  }

  // Adds the accounts a restore left, then drops passwords of writes that crashed
  // before their catalog commit and the revisions a crashed password change left
  // beside the committed one.
  recover() {
    if (!fs.existsSync(this.root)) return;
    // A failed cleanup only leaves files behind; it never stops startup.
    try {
      // Before the cleanup: a restored password stays pending until this import.
      this.importRestored();
      const rows = this.rows();
      this.passwords.removeOrphans(rows.map((row) => row.id));
      for (const row of rows) this.passwords.removeOthers(row.id, row.credentialRevision);
      this.textCache.removeOrphans(rows.map((row) => row.id));
    } catch (error) {
      console.warn(`Mail accounts kept their password files (${error.code || "error"}).`);
    }
  }

  /** Adds the accounts a restore left behind; repeated after an interruption. */
  importRestored() {
    const file = path.join(this.root, mailRestoreFile);
    if (!fs.existsSync(file)) return;
    let readable;
    try {
      readable = Array.isArray(readJSON(file, null)?.accounts);
    } catch {
      readable = false;
    }
    // Never echoes the file: it is removed with the passwords nobody can import.
    if (!readable) console.warn("Mail accounts: the restore file could not be read.");
    const merged = mergeRestoredMailAccounts(file, {
      version: VERSION,
      accounts: this.rows(),
    });
    if (merged) this.save(merged.accounts);
    fs.rmSync(file, { force: true });
  }

  rows() {
    let catalog;
    try {
      catalog = readJSON(this.file, { version: VERSION, accounts: [] });
    } catch {
      catalog = null;
    }
    // Never echoes the file: a parse error would quote its content.
    if (catalog?.version !== VERSION || !Array.isArray(catalog.accounts))
      throw Object.assign(problem(serverMessages.mail.catalogUnreadable, 500), {
        code: "MAIL_CATALOG_UNREADABLE",
      });
    return catalog.accounts;
  }

  save(rows) {
    privateDirectory(this.root);
    writePrivate(this.file, { version: VERSION, accounts: rows });
  }

  row(id) {
    const row = this.rows().find((item) => item.id === id);
    if (!row) throw problem(serverMessages.mail.accountNotFound, 404);
    return row;
  }

  view(row) {
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      displayName: row.displayName,
      preset: row.preset,
      imap: { ...row.imap },
      smtp: { ...row.smtp },
      allowPlaintext: row.allowPlaintext,
      saveSent: row.saveSent,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastTest: row.lastTest ?? null,
      hasPassword: true,
    };
  }

  list() {
    return this.rows().map((row) => this.view(row));
  }

  get(id) {
    return this.view(this.row(id));
  }

  create(input, principal) {
    const { password, ...fields } = accountInput(input);
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      ...fields,
      credentialRevision: randomUUID(),
      createdAt: now,
      updatedAt: now,
      lastTest: null,
    };
    const rows = this.rows();
    privateDirectory(this.root);
    this.passwords.write(row.id, row.credentialRevision, password);
    try {
      this.save([...rows, row]);
    } catch (error) {
      this.passwords.removeHost(row.id);
      throw error;
    }
    this.passwords.settle(row.id);
    this.record("mail.created", row.id, principal, {});
    return this.view(row);
  }

  update(id, input, principal) {
    const stored = this.row(id);
    const { password, ...fields } = accountInput(input, { existing: stored });
    const changed = fieldNames.filter(
      (key) => JSON.stringify(fields[key]) !== JSON.stringify(stored[key]),
    );
    if (password !== undefined) changed.push("password");
    // Nothing changed: no write, no new updatedAt, no audit.
    if (!changed.length) return this.view(stored);
    const row = {
      ...stored,
      ...fields,
      credentialRevision:
        password === undefined ? stored.credentialRevision : randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    if (password !== undefined)
      this.passwords.write(id, row.credentialRevision, password);
    try {
      this.save(this.rows().map((item) => (item.id === id ? row : item)));
    } catch (error) {
      // The committed password stays: drop only the new revision and its marker.
      if (password !== undefined) {
        fs.rmSync(this.passwords.file(id, row.credentialRevision), { force: true });
        this.passwords.settle(id);
      }
      throw error;
    }
    if (password !== undefined) {
      this.passwords.settle(id);
      this.passwords.removeOthers(id, row.credentialRevision);
    }
    // Another server or login may be another mailbox: its UIDs say nothing about the
    // text cached for the old one.
    if (mailboxIdentity(stored) !== mailboxIdentity(row)) this.textCache.clearAccount(id);
    this.record("mail.updated", id, principal, { fields: changed });
    return this.view(row);
  }

  remove(id, principal) {
    this.row(id);
    this.onRemoved?.(id);
    // Pending before the commit: if removing the directory fails below, startup finds
    // a pending directory without a catalog row and removes it.
    if (fs.existsSync(this.passwords.hostDirectory(id))) this.passwords.markPending(id);
    try {
      this.save(this.rows().filter((item) => item.id !== id));
    } catch (error) {
      this.passwords.settle(id);
      throw error;
    }
    // Never throws, so the cached text goes even if the password removal fails.
    this.textCache.removeAccount(id);
    this.passwords.removeHost(id);
    this.record("mail.deleted", id, principal, {});
  }

  /** The connection fields and password of an account; in-process only. */
  credentials(id) {
    const row = this.row(id);
    return {
      account: connection(row),
      password: this.passwords.read(id, row.credentialRevision),
    };
  }

  options() {
    return this.tlsCa === undefined ? {} : { ca: this.tlsCa };
  }

  async test(id, principal) {
    const { account, password } = this.credentials(id);
    const result = await this.connect.testMailAccount(account, password, this.options());
    const lastTest = {
      at: new Date().toISOString(),
      imap: resultCode(result.imap),
      smtp: resultCode(result.smtp),
    };
    // A concurrent removal must not bring the account back.
    const rows = this.rows();
    if (rows.some((row) => row.id === id)) {
      this.save(rows.map((row) => (row.id === id ? { ...row, lastTest } : row)));
      this.record(
        "mail.tested",
        id,
        principal,
        { imap: lastTest.imap, smtp: lastTest.smtp },
        result.imap?.ok && result.smtp?.ok ? "success" : "failure",
      );
    }
    return result;
  }

  /** Tests unsaved fields; with `accountId` they change that account and may reuse
   * its password, but only against the same servers. Nothing is stored or audited. */
  async testInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw problem(serverMessages.mail.invalidAccount);
    const { accountId, ...raw } = input;
    const existing = accountId === undefined ? undefined : this.row(accountId);
    // The name only labels a saved account; a test needs none.
    const fields = accountInput(
      existing || raw.name !== undefined ? raw : { ...raw, name: "test" },
      { existing, requirePassword: !existing },
    );
    const password =
      fields.password ?? this.passwords.read(existing.id, existing.credentialRevision);
    return this.connect.testMailAccount(connection(fields), password, this.options());
  }

  async withImap(id, fn) {
    const { account, password } = this.credentials(id);
    return this.connect.withImap(account, password, fn, this.options());
  }

  async sendRaw(id, { envelope, raw }) {
    const { account, password } = this.credentials(id);
    return this.connect.smtpSend(account, password, { envelope, raw }, this.options());
  }

  // The change is committed: a failing audit must not undo it, so it is logged with
  // its code only.
  record(action, id, principal, details, outcome = "success") {
    try {
      this.audit?.append({
        action,
        resourceType: "mail",
        resourceId: id,
        source: "user",
        outcome,
        ...auditActor(principal),
        details: { kind: "account", ...details },
      });
    } catch (error) {
      console.error("Mail audit failed:", error?.code || "error");
    }
  }
}

const mailboxIdentity = ({ imap }) =>
  JSON.stringify([imap?.host, imap?.port, imap?.security, imap?.username]);

function connection({ address, imap, smtp, allowPlaintext }) {
  return { address, imap: { ...imap }, smtp: { ...smtp }, allowPlaintext };
}
