import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MailAccountStore } from "../../server/features/mail/mail-account-store.js";
import {
  accountInput,
  mailPresets,
} from "../../server/features/mail/mail-account-fields.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { startFakeImap } from "../helpers/fake-imap-server.js";
import { startFakeSmtp } from "../helpers/fake-smtp-server.js";

const owner = { role: "owner" };
const gmail = {
  name: "Private",
  address: "owner@example.com",
  displayName: "Owner",
  preset: "gmail",
};
const generic = (port, security = "tls") => ({
  name: "Work",
  address: "owner@example.com",
  preset: "generic",
  imap: { host: "127.0.0.1", port, security },
  smtp: { host: "127.0.0.1", port, security },
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-mail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Every audit event passes the real schema, as the audit store would check it.
function auditLog() {
  const events = [];
  return { events, append: (input) => events.push(auditEvent(input)) };
}

function store(t, options = {}) {
  const dataDir = options.dataDir ?? tempDir(t);
  const audit = options.audit ?? auditLog();
  const s = new MailAccountStore({ dataDir, audit, ...options });
  return Object.assign(s, { dataDir, auditLog: audit });
}

const passwordDirectory = (dataDir, id) => path.join(dataDir, "mail/passwords", id);
function passwordFile(dataDir, id) {
  const directory = passwordDirectory(dataDir, id);
  const files = fs.readdirSync(directory).filter((name) => name !== ".pending");
  assert.equal(files.length, 1);
  return path.join(directory, files[0]);
}
const catalog = (dataDir) =>
  JSON.parse(fs.readFileSync(path.join(dataDir, "mail/accounts.json"), "utf8"));

test("an account keeps its password in a 0600 file and never shows it", async (t) => {
  const s = store(t);
  await s.ready;
  const a = s.create({ ...gmail, password: "pw-secret" }, owner);
  assert.equal(a.hasPassword, true);
  assert.equal(JSON.stringify(s.list()).includes("pw-secret"), false);
  const file = passwordFile(s.dataDir, a.id);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(passwordDirectory(s.dataDir, a.id)).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(file, "utf8"), "pw-secret");
  assert.equal(
    fs.existsSync(path.join(passwordDirectory(s.dataDir, a.id), ".pending")),
    false,
  );
  const raw = fs.readFileSync(path.join(s.dataDir, "mail/accounts.json"), "utf8");
  assert.equal(raw.includes("pw-secret"), false);
  assert.equal(
    fs.statSync(path.join(s.dataDir, "mail/accounts.json")).mode & 0o777,
    0o600,
  );
  assert.equal(catalog(s.dataDir).version, 1);
  assert.deepEqual(Object.keys(a).sort(), [
    "address",
    "allowPlaintext",
    "createdAt",
    "displayName",
    "hasPassword",
    "id",
    "imap",
    "lastTest",
    "name",
    "preset",
    "saveSent",
    "smtp",
    "updatedAt",
  ]);
  assert.deepEqual(a.imap, {
    host: "imap.gmail.com",
    port: 993,
    security: "tls",
    username: "owner@example.com",
  });
  assert.deepEqual(a.smtp, {
    host: "smtp.gmail.com",
    port: 465,
    security: "tls",
    username: "owner@example.com",
  });
  assert.equal(a.saveSent, false);
  assert.equal(a.lastTest, null);
  assert.deepEqual(s.get(a.id), a);
  const created = s.auditLog.events.at(-1);
  assert.equal(created.action, "mail.created");
  assert.equal(created.resourceType, "mail");
  assert.equal(created.resourceId, a.id);
  assert.deepEqual(created.details, { kind: "account" });
  assert.equal(JSON.stringify(s.auditLog.events).includes("pw-secret"), false);
  assert.equal(JSON.stringify(s.auditLog.events).includes("example.com"), false);
});

test("an unknown account is 404", async (t) => {
  const s = store(t);
  await s.ready;
  assert.throws(() => s.get("00000000-0000-4000-8000-000000000000"), {
    status: 404,
    message: serverMessages.mail.accountNotFound,
  });
  assert.throws(() => s.get("../etc"), { status: 404 });
  assert.deepEqual(s.list(), []);
});

test("an update without password keeps it; with one it replaces the revision", async (t) => {
  const s = store(t);
  const a = s.create({ ...gmail, password: "pw-first" }, owner);
  const first = passwordFile(s.dataDir, a.id);
  const renamed = s.update(a.id, { name: "Renamed", saveSent: true }, owner);
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.saveSent, true);
  assert.equal(renamed.address, a.address);
  assert.equal(passwordFile(s.dataDir, a.id), first);
  assert.deepEqual(s.auditLog.events.at(-1).details, {
    kind: "account",
    fields: ["name", "saveSent"],
  });
  s.update(a.id, { password: "pw-second" }, owner);
  const second = passwordFile(s.dataDir, a.id);
  assert.notEqual(second, first);
  assert.equal(fs.readFileSync(second, "utf8"), "pw-second");
  assert.equal(fs.existsSync(first), false);
  assert.deepEqual(s.auditLog.events.at(-1).details, {
    kind: "account",
    fields: ["password"],
  });
  assert.equal(JSON.stringify(s.auditLog.events).includes("pw-second"), false);
  assert.equal(JSON.stringify(catalog(s.dataDir)).includes("pw-second"), false);
  assert.throws(() => s.update(a.id, { password: "a\nb" }, owner), {
    status: 400,
    message: serverMessages.mail.invalidPassword,
  });
  assert.equal(passwordFile(s.dataDir, a.id), second);
  assert.throws(() => s.update(a.id, { unknown: true }, owner), {
    status: 400,
    message: serverMessages.mail.invalidAccount,
  });
});

test("plaintext needs allowPlaintext", async (t) => {
  const s = store(t);
  assert.throws(() => s.create({ ...generic(143, "none"), password: "pw" }, owner), {
    status: 400,
    message: serverMessages.mail.plaintextNeedsConsent,
  });
  assert.equal(fs.existsSync(path.join(s.dataDir, "mail/accounts.json")), false);
  assert.equal(fs.existsSync(path.join(s.dataDir, "mail/passwords")), false);
  assert.equal(s.auditLog.events.length, 0);
  const a = s.create(
    { ...generic(143, "none"), allowPlaintext: true, password: "pw" },
    owner,
  );
  assert.equal(a.allowPlaintext, true);
  assert.throws(() => s.update(a.id, { allowPlaintext: false }, owner), {
    status: 400,
    message: serverMessages.mail.plaintextNeedsConsent,
  });
  assert.equal(s.get(a.id).allowPlaintext, true);
});

test("account fields are validated strictly", () => {
  const ok = accountInput({ ...generic(993), password: "pw" });
  assert.equal(ok.imap.username, "owner@example.com");
  assert.equal(ok.smtp.username, "owner@example.com");
  assert.equal(ok.saveSent, true);
  assert.equal(ok.allowPlaintext, false);
  assert.equal(ok.password, "pw");
  assert.equal(mailPresets.generic.saveSent, true);
  assert.equal(mailPresets.gmail.saveSent, false);
  const invalid = { status: 400, message: serverMessages.mail.invalidAccount };
  const bad = [
    null,
    { ...generic(993), password: "pw", extra: 1 },
    { ...generic(0), password: "pw" },
    { ...generic(65536), password: "pw" },
    { ...generic("993"), password: "pw" },
    { ...generic(993, "ssl"), password: "pw" },
    {
      ...generic(993),
      imap: { host: "bad host", port: 993, security: "tls" },
      password: "pw",
    },
    {
      ...generic(993),
      imap: { host: "a".repeat(254), port: 993, security: "tls" },
      password: "pw",
    },
    {
      ...generic(993),
      imap: { host: "x.org", port: 993, security: "tls", more: 1 },
      password: "pw",
    },
    { ...generic(993), address: "Bob <bob@example.com>", password: "pw" },
    { ...generic(993), address: "a@b.c, d@e.f", password: "pw" },
    { ...generic(993), address: "no-at-sign", password: "pw" },
    { ...generic(993), address: `${"a".repeat(320)}@x.org`, password: "pw" },
    { ...generic(993), preset: "yahoo", password: "pw" },
    { ...generic(993), saveSent: "yes", password: "pw" },
    { ...generic(993), displayName: "a\nb", password: "pw" },
    { ...gmail, password: "pw", preset: "generic" },
  ];
  for (const raw of bad)
    assert.throws(() => accountInput(raw), invalid, JSON.stringify(raw));
  assert.throws(() => accountInput({ ...generic(993), name: "", password: "pw" }), {
    status: 400,
  });
  assert.throws(() => accountInput({ ...generic(993) }), {
    status: 400,
    message: serverMessages.mail.invalidPassword,
  });
  const v6 = accountInput({
    ...generic(993),
    imap: { host: "::1", port: 993, security: "starttls", username: "u" },
    password: "pw",
  });
  assert.equal(v6.imap.host, "::1");
  assert.equal(v6.smtp.username, "u");
});

test("a crashed write leaves no orphan after ready", async (t) => {
  const dataDir = tempDir(t);
  const first = store(t, { dataDir });
  await first.ready;
  const kept = first.create({ ...gmail, password: "pw-kept" }, owner);
  // A crash after the password write, before the catalog commit.
  const orphan = "11111111-1111-4111-8111-111111111111";
  first.passwords.write(orphan, "22222222-2222-4222-8222-222222222222", "pw-lost");
  // A crash during a password change of a committed account.
  const stale = "33333333-3333-4333-8333-333333333333";
  first.passwords.write(kept.id, stale, "pw-new");
  const second = store(t, { dataDir });
  await second.ready;
  assert.equal(fs.existsSync(passwordDirectory(dataDir, orphan)), false);
  assert.equal(
    fs.existsSync(path.join(passwordDirectory(dataDir, kept.id), stale)),
    false,
  );
  assert.equal(fs.readFileSync(passwordFile(dataDir, kept.id), "utf8"), "pw-kept");
  assert.equal(
    fs.existsSync(path.join(passwordDirectory(dataDir, kept.id), ".pending")),
    false,
  );
  assert.deepEqual(
    second.list().map((a) => a.id),
    [kept.id],
  );
});

test("remove calls onRemoved before deleting the password", async (t) => {
  const s = store(t);
  const a = s.create({ ...gmail, password: "pw-secret" }, owner);
  const seen = [];
  s.onRemoved = (id) => {
    seen.push({
      id,
      listed: s.list().some((row) => row.id === id),
      password: fs.existsSync(passwordDirectory(s.dataDir, id)),
    });
  };
  s.remove(a.id, owner);
  assert.deepEqual(seen, [{ id: a.id, listed: true, password: true }]);
  assert.equal(fs.existsSync(passwordDirectory(s.dataDir, a.id)), false);
  assert.deepEqual(s.list(), []);
  const deleted = s.auditLog.events.at(-1);
  assert.equal(deleted.action, "mail.deleted");
  assert.equal(deleted.resourceId, a.id);
  assert.deepEqual(deleted.details, { kind: "account" });
  assert.throws(() => s.remove(a.id, owner), { status: 404 });
});

test("test stores lastTest codes and audits mail.tested without host or address", async (t) => {
  const calls = [];
  const connect = {
    async testMailAccount(account, password, options) {
      calls.push({ account, password, options });
      return { imap: { ok: true }, smtp: { ok: false, code: "MAIL_AUTH_FAILED" } };
    },
  };
  const s = store(t, { connect, tlsCa: "CA" });
  const a = s.create({ ...generic(993), password: "pw-secret" }, owner);
  const result = await s.test(a.id, owner);
  assert.deepEqual(result, {
    imap: { ok: true },
    smtp: { ok: false, code: "MAIL_AUTH_FAILED" },
  });
  assert.equal(calls[0].password, "pw-secret");
  assert.deepEqual(calls[0].options, { ca: "CA" });
  assert.equal(calls[0].account.imap.host, "127.0.0.1");
  const lastTest = s.get(a.id).lastTest;
  assert.equal(lastTest.imap, "ok");
  assert.equal(lastTest.smtp, "MAIL_AUTH_FAILED");
  assert.ok(!Number.isNaN(Date.parse(lastTest.at)));
  const tested = s.auditLog.events.at(-1);
  assert.equal(tested.action, "mail.tested");
  assert.equal(tested.outcome, "failure");
  assert.deepEqual(tested.details, {
    kind: "account",
    imap: "ok",
    smtp: "MAIL_AUTH_FAILED",
  });
  const text = JSON.stringify(s.auditLog.events);
  for (const secret of ["pw-secret", "127.0.0.1", "example.com"])
    assert.equal(text.includes(secret), false, secret);
});

test("a test of a removed account does not bring it back", async (t) => {
  let release;
  const connect = {
    testMailAccount: () =>
      new Promise((resolve) => {
        release = () => resolve({ imap: { ok: true }, smtp: { ok: true } });
      }),
  };
  const s = store(t, { connect });
  const a = s.create({ ...gmail, password: "pw" }, owner);
  const pending = s.test(a.id, owner);
  await new Promise((resolve) => setImmediate(resolve));
  s.remove(a.id, owner);
  release();
  await pending;
  assert.deepEqual(s.list(), []);
});

test("testInput checks unsaved fields and reuses a saved password on its servers", async (t) => {
  const calls = [];
  const connect = {
    async testMailAccount(account, password) {
      calls.push({ account, password });
      return { imap: { ok: true }, smtp: { ok: true } };
    },
  };
  const s = store(t, { connect });
  const a = s.create({ ...generic(993), password: "pw-saved" }, owner);
  await s.testInput({ ...generic(993), password: "pw-typed" });
  assert.equal(calls[0].password, "pw-typed");
  // Same servers, other username: the saved password may be reused.
  await s.testInput({
    accountId: a.id,
    imap: { username: "other" },
    address: "other@example.com",
  });
  assert.equal(calls[1].password, "pw-saved");
  assert.equal(calls[1].account.imap.username, "other");
  await assert.rejects(s.testInput({ ...generic(993, "bogus"), password: "pw" }), {
    status: 400,
  });
  await assert.rejects(s.testInput({ ...generic(993, "none"), password: "pw" }), {
    status: 400,
    message: serverMessages.mail.plaintextNeedsConsent,
  });
  await assert.rejects(s.testInput({ ...generic(993) }), { status: 400 });
  assert.equal(calls.length, 2);
  assert.equal(s.auditLog.events.at(-1).action, "mail.created");
  assert.equal(s.get(a.id).lastTest, null);
});

// Each change moves the account to another server endpoint.
const endpointChanges = {
  imapHost: { imap: { host: "imap.evil.example" } },
  smtpHost: { smtp: { host: "smtp.evil.example" } },
  imapPort: { imap: { port: 995 } },
  smtpPort: { smtp: { port: 587 } },
  security: { smtp: { security: "starttls" } },
  preset: {
    preset: "gmail",
  },
};

test("a saved password never goes to a changed server without a new one", async (t) => {
  let connects = 0;
  const connect = {
    async testMailAccount() {
      connects += 1;
      return { imap: { ok: true }, smtp: { ok: true } };
    },
  };
  const s = store(t, { connect });
  const a = s.create({ ...generic(993), password: "pw-saved" }, owner);
  const before = catalog(s.dataDir);
  const refused = { status: 400, message: serverMessages.mail.passwordRequiredForServer };
  for (const [label, change] of Object.entries(endpointChanges)) {
    await assert.rejects(s.testInput({ accountId: a.id, ...change }), refused, label);
    assert.throws(() => s.update(a.id, change, owner), refused, label);
  }
  assert.equal(connects, 0);
  assert.deepEqual(catalog(s.dataDir), before);
  assert.equal(s.auditLog.events.length, 1);
  for (const [label, change] of Object.entries(endpointChanges)) {
    await s.testInput({ accountId: a.id, ...change, password: "pw-new" });
    assert.equal(connects, 1, label);
    connects = 0;
  }
  const moved = s.update(a.id, { imap: { port: 995 }, password: "pw-new" }, owner);
  assert.equal(moved.imap.port, 995);
  assert.deepEqual(s.auditLog.events.at(-1).details, {
    kind: "account",
    fields: ["imap", "password"],
  });
  // The username and address on the same servers stay editable without a password.
  const renamed = s.update(
    a.id,
    { address: "new@example.com", imap: { username: "new" } },
    owner,
  );
  assert.equal(renamed.imap.username, "new");
});

test("an update without a change writes and audits nothing", async (t) => {
  const s = store(t);
  const a = s.create({ ...gmail, password: "pw" }, owner);
  const before = fs.readFileSync(path.join(s.dataDir, "mail/accounts.json"), "utf8");
  const same = s.update(a.id, { name: a.name, saveSent: a.saveSent }, owner);
  assert.deepEqual(same, a);
  assert.equal(
    fs.readFileSync(path.join(s.dataDir, "mail/accounts.json"), "utf8"),
    before,
  );
  assert.equal(s.auditLog.events.length, 1);
});

test("an unreadable catalog fails without echoing its content", async (t) => {
  for (const content of ["{ broken pw-secret", JSON.stringify({ version: 2 })]) {
    const s = store(t);
    s.create({ ...gmail, password: "pw" }, owner);
    fs.writeFileSync(path.join(s.dataDir, "mail/accounts.json"), content);
    for (const run of [
      () => s.list(),
      () => s.create({ ...gmail, password: "x" }, owner),
    ])
      assert.throws(run, (error) => {
        assert.equal(error.status, 500);
        assert.equal(error.code, "MAIL_CATALOG_UNREADABLE");
        assert.equal(error.message, serverMessages.mail.catalogUnreadable);
        assert.equal(String(error.stack).includes("pw-secret"), false);
        return true;
      });
    // Startup only warns and keeps every password file.
    const again = store(t, { dataDir: s.dataDir });
    await again.ready;
    assert.equal(fs.readdirSync(path.join(s.dataDir, "mail/passwords")).length, 1);
  }
});

test("a password directory left by a failed removal is collected on startup", async (t) => {
  const s = store(t);
  const a = s.create({ ...gmail, password: "pw" }, owner);
  s.passwords.removeHost = () => {
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  };
  assert.throws(() => s.remove(a.id, owner), { code: "EBUSY" });
  assert.deepEqual(s.list(), []);
  assert.equal(
    fs.existsSync(path.join(passwordDirectory(s.dataDir, a.id), ".pending")),
    true,
  );
  const again = store(t, { dataDir: s.dataDir });
  await again.ready;
  assert.equal(fs.existsSync(passwordDirectory(s.dataDir, a.id)), false);
});

test("an unreadable password file is reported without its content", async (t) => {
  const s = store(t);
  const a = s.create({ ...gmail, password: "pw-secret" }, owner);
  fs.chmodSync(passwordFile(s.dataDir, a.id), 0o644);
  await assert.rejects(
    s.withImap(a.id, async () => {}),
    {
      status: 409,
      message: serverMessages.mail.passwordUnavailable,
    },
  );
});

test("the store connects to real fake servers with its CA", async (t) => {
  const users = { "owner@example.com": "pw-secret" };
  const imap = await startFakeImap({ security: "tls", users });
  const smtp = await startFakeSmtp({ security: "tls", users });
  t.after(() => Promise.all([imap.close(), smtp.close()]));
  const s = store(t, { tlsCa: [imap.ca, smtp.ca] });
  const a = s.create(
    {
      ...generic(imap.port),
      smtp: { host: "127.0.0.1", port: smtp.port, security: "tls" },
      password: "pw-secret",
    },
    owner,
  );
  assert.deepEqual(await s.test(a.id, owner), {
    imap: { ok: true },
    smtp: { ok: true },
  });
  assert.equal(s.auditLog.events.at(-1).outcome, "success");
  const folders = await s.withImap(a.id, async (client) =>
    (await client.list()).map((f) => f.path),
  );
  assert.ok(folders.includes("INBOX"));
  const sent = await s.sendRaw(a.id, {
    envelope: { from: "owner@example.com", to: ["bob@example.org"] },
    raw: "From: owner@example.com\r\nTo: bob@example.org\r\nSubject: Hi\r\n\r\nHello\r\n",
  });
  assert.equal(sent.accepted, 1);
  assert.equal(smtp.messages.length, 1);
});
