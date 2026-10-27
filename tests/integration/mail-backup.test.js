import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { decryptCredentials } from "../../server/features/operations/archive.js";
import { MailAccountStore } from "../../server/features/mail/mail-account-store.js";
import {
  mailAccountsMember,
  mailAccountsOmission,
  mailAccountsPresent,
  mailRestoreFile,
  mergeRestoredMailAccounts,
  restoreMailAccounts,
  unreadableMailAccountOmission,
} from "../../server/features/mail/mail-backup.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { archiveText, loadArchive } from "../helpers/backup-archive.js";

const passphrase = "mail backup passphrase";
const secret = "mail-pw-secret-3f9a2";

async function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-mb-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "live");
  fs.mkdirSync(dataDir);
  const store = new MailAccountStore({ dataDir });
  await store.ready;
  const account = store.create({
    name: "Support",
    address: "support@example.com",
    imap: { host: "imap.example.com" },
    smtp: { host: "smtp.example.com" },
    password: secret,
  });
  return { root, dataDir, store, account };
}

async function start(dataDir) {
  const store = new MailAccountStore({ dataDir });
  await store.ready;
  return store;
}

const sealed = (dataDir, includeHistory = false) =>
  new Backup({ dataDir }).create({ includeHistory, withCredentials: true, passphrase });

async function restore(root, dataDir, made, name = made.backup.id) {
  const target = path.join(root, `restored-${name}`);
  const report = await new Restore({ dataDir }).apply({
    archive: made.file,
    targetDataDir: target,
    passphrase,
  });
  return { target, report };
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function catalogRow(dataDir, id) {
  const catalog = JSON.parse(fs.readFileSync(path.join(dataDir, "mail/accounts.json")));
  return catalog.accounts.find((row) => row.id === id);
}

function stageWith(dataDir, value) {
  const stage = fs.mkdtempSync(path.join(path.dirname(dataDir), "stage-"));
  fs.mkdirSync(path.join(stage, "mail"), { mode: 0o700 });
  fs.writeFileSync(path.join(stage, mailAccountsMember), JSON.stringify(value), {
    mode: 0o600,
  });
  return stage;
}

test("a host without mail accounts lists nothing about them", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-mb-empty-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  assert.equal(mailAccountsPresent(dataDir), false);
  const backup = new Backup({ dataDir });
  for (const withCredentials of [false, true]) {
    const plan = backup.plan({ withCredentials });
    assert.equal(plan.components.includes("sealed-mail-accounts"), false);
    assert.equal(plan.omissions.includes(mailAccountsOmission), false);
  }
});

test("an ordinary backup lists the omission and holds nothing of mail", async (t) => {
  const { dataDir } = await setup(t);
  assert.equal(mailAccountsPresent(dataDir), true);
  const backup = new Backup({ dataDir });
  const plan = backup.plan({});
  assert.ok(plan.omissions.includes(mailAccountsOmission));
  assert.equal(plan.components.includes("sealed-mail-accounts"), false);
  const made = await backup.create({ includeHistory: false });
  assert.ok(made.manifest.omissions.includes(mailAccountsOmission));
  const archive = loadArchive(made.file);
  assert.equal(archive.credentials, undefined);
  const text = archiveText(made.file);
  for (const needle of [secret, "mail/passwords", mailAccountsMember, "support@example"])
    assert.equal(text.includes(needle), false, needle);
  assert.equal(
    archive.files.some((member) => member.path.startsWith("mail/")),
    false,
  );
});

test("a passphrase backup seals the accounts with their passwords", async (t) => {
  const { dataDir, account } = await setup(t);
  const credentialed = new Backup({ dataDir }).plan({ withCredentials: true });
  assert.ok(credentialed.components.includes("sealed-mail-accounts"));
  assert.equal(credentialed.omissions.includes(mailAccountsOmission), false);
  for (const includeHistory of [false, true]) {
    const made = await sealed(dataDir, includeHistory);
    assert.equal(made.manifest.omissions.includes(mailAccountsOmission), false);
    const archive = loadArchive(made.file);
    assert.equal(archiveText(made.file).includes(secret), false);
    assert.equal(
      archive.files.some((member) => member.path.startsWith("mail/")),
      false,
    );
    const opened = await decryptCredentials(archive.credentials, passphrase);
    const member = opened.find((entry) => entry.path === mailAccountsMember);
    assert.ok(member, opened.map((entry) => entry.path).join(","));
    const value = JSON.parse(Buffer.from(member.content, "base64").toString("utf8"));
    assert.equal(value.version, 1);
    assert.deepEqual(
      value.accounts.map((row) => row.id),
      [account.id],
    );
    assert.deepEqual(value.passwords, { [account.id]: secret });
  }
});

test("an account whose password cannot be read is named as omitted", async (t) => {
  const { dataDir, account } = await setup(t);
  const { credentialRevision } = catalogRow(dataDir, account.id);
  // The store refuses a password file others may read.
  fs.chmodSync(
    path.join(dataDir, "mail/passwords", account.id, credentialRevision),
    0o644,
  );
  const made = await sealed(dataDir);
  assert.ok(
    made.manifest.omissions.includes(unreadableMailAccountOmission("Support")),
    made.manifest.omissions.join("|"),
  );
  assert.equal(archiveText(made.file).includes(secret), false);
  const opened = await decryptCredentials(loadArchive(made.file).credentials, passphrase);
  assert.equal(
    opened.some((entry) => entry.path === mailAccountsMember),
    false,
  );
});

test("a restore brings the account back with its id and password", async (t) => {
  const { root, dataDir, account } = await setup(t);
  const made = await sealed(dataDir);
  const { target, report } = await restore(root, dataDir, made);
  assert.deepEqual(report.mailAccounts, { restored: 1 });
  assert.equal(JSON.stringify(report).includes(secret), false);
  // Only the password store holds the password; the capsule member is gone.
  assert.equal(fs.existsSync(path.join(target, mailAccountsMember)), false);
  const holding = walk(target).filter((file) =>
    fs.readFileSync(file, "latin1").includes(secret),
  );
  assert.equal(holding.length, 1, holding.join(","));
  assert.ok(holding[0].startsWith(path.join(target, "mail/passwords", account.id)));
  assert.equal(fs.statSync(holding[0]).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(target, "mail")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(target, "mail/passwords")).mode & 0o777, 0o700);
  // Until the first start imports the account, its password directory is pending.
  const pending = path.join(target, "mail/passwords", account.id, ".pending");
  assert.ok(fs.existsSync(pending));
  assert.ok(fs.existsSync(path.join(target, "mail", mailRestoreFile)));
  const store = await start(target);
  const [back] = store.list();
  assert.equal(back.id, account.id);
  assert.equal(back.address, "support@example.com");
  assert.equal(back.imap.host, "imap.example.com");
  assert.equal(store.credentials(account.id).password, secret);
  assert.equal(fs.existsSync(path.join(target, "mail", mailRestoreFile)), false);
  assert.equal(fs.existsSync(pending), false);
  // A second start keeps the account and its password.
  const again = await start(target);
  assert.equal(again.list().length, 1);
  assert.equal(again.credentials(account.id).password, secret);
});

test("a restore refuses crafted mail members and leaves nothing behind", async (t) => {
  const { dataDir, account } = await setup(t);
  const row = catalogRow(dataDir, account.id);
  const passwords = { [account.id]: secret };
  const other = "00000000-0000-4000-8000-000000000001";
  const cases = [
    { version: 2, accounts: [row], passwords },
    { version: 1, accounts: "x", passwords },
    // An account without its password.
    { version: 1, accounts: [row], passwords: {} },
    { version: 1, accounts: [{ ...row, id: "../x" }], passwords: { "../x": secret } },
    { version: 1, accounts: [{ ...row, credentialRevision: "x" }], passwords },
    { version: 1, accounts: [row, row], passwords },
    { version: 1, accounts: [{ ...row, password: secret }], passwords },
    {
      version: 1,
      accounts: [{ ...row, imap: { ...row.imap, security: "none" } }],
      passwords,
    },
    { version: 1, accounts: [{ ...row, address: "Bob <b@example.com>" }], passwords },
    { version: 1, accounts: [row], passwords: { [account.id]: "a\nb" } },
    { version: 1, accounts: [{ ...row, id: other }], passwords },
  ];
  for (const value of cases) {
    const stage = stageWith(dataDir, value);
    assert.throws(
      () => restoreMailAccounts(stage),
      (error) => error.message === serverMessages.backups.unexpectedComponent,
      JSON.stringify(value).slice(0, 120),
    );
    assert.equal(fs.existsSync(path.join(stage, mailAccountsMember)), false);
    assert.equal(fs.existsSync(path.join(stage, "mail/passwords")), false);
    assert.equal(fs.existsSync(path.join(stage, "mail", mailRestoreFile)), false);
  }
  const empty = fs.mkdtempSync(path.join(path.dirname(dataDir), "stage-"));
  assert.equal(restoreMailAccounts(empty), null);
});

test("the startup import never duplicates or overwrites an account", async (t) => {
  const { root, dataDir, account } = await setup(t);
  const made = await sealed(dataDir);
  const { target } = await restore(root, dataDir, made);
  const pending = path.join(target, "mail", mailRestoreFile);
  const copy = fs.readFileSync(pending);
  await start(target);
  // An import interrupted after its catalog write runs again on the next start.
  fs.writeFileSync(pending, copy, { mode: 0o600 });
  const restarted = await start(target);
  assert.deepEqual(
    restarted.list().map((row) => row.id),
    [account.id],
  );
  assert.equal(fs.existsSync(pending), false);
  // An existing account with the same id keeps its own fields.
  restarted.update(account.id, { name: "Renamed" });
  const crafted = JSON.parse(copy);
  crafted.accounts[0].name = "From backup";
  const current = JSON.parse(fs.readFileSync(path.join(target, "mail/accounts.json")));
  fs.writeFileSync(pending, JSON.stringify(crafted), { mode: 0o600 });
  assert.equal(mergeRestoredMailAccounts(pending, current), null);
  const third = await start(target);
  assert.deepEqual(
    third.list().map((row) => row.name),
    ["Renamed"],
  );
  assert.equal(third.credentials(account.id).password, secret);
});

test("an unreadable restore file leaves no password without its account", async (t) => {
  const { root, dataDir, account } = await setup(t);
  const made = await sealed(dataDir);
  const { target } = await restore(root, dataDir, made);
  const pending = path.join(target, "mail", mailRestoreFile);
  fs.writeFileSync(pending, "{not json", { mode: 0o600 });
  assert.equal(mergeRestoredMailAccounts(pending, { version: 1, accounts: [] }), null);
  const store = await start(target);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(pending), false);
  // The pending password of the account that was never imported is removed.
  assert.equal(fs.existsSync(path.join(target, "mail/passwords", account.id)), false);
});

test("a wrong passphrase restores nothing", async (t) => {
  const { root, dataDir } = await setup(t);
  const made = await sealed(dataDir);
  const before = fs.readdirSync(root).sort();
  const target = path.join(root, "restored-wrong");
  await assert.rejects(
    new Restore({ dataDir }).apply({
      archive: made.file,
      targetDataDir: target,
      passphrase: "not the right passphrase",
    }),
    (error) => !error.message.includes(secret),
  );
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});
