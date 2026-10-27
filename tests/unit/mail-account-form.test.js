import test from "node:test";
import assert from "node:assert/strict";
import {
  accountBody,
  formValues,
  isDirty,
  needsPlaintext,
  passwordRequired,
  presetFields,
  saveBlocker,
  testBody,
  withPreset,
} from "../../web/features/mail/mail-account-form.js";

const saved = {
  id: "acc-1",
  name: "Support",
  address: "support@example.com",
  displayName: "Support team",
  preset: "generic",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "support" },
  smtp: { host: "smtp.example.com", port: 465, security: "tls", username: "support" },
  allowPlaintext: false,
  saveSent: true,
  hasPassword: true,
};

test("presets fill the servers the server-side presets use", () => {
  assert.deepEqual(presetFields("gmail"), {
    imap: { host: "imap.gmail.com", port: 993, security: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
    saveSent: false,
  });
  assert.deepEqual(presetFields("generic"), {
    imap: { host: "", port: 993, security: "tls" },
    smtp: { host: "", port: 465, security: "tls" },
    saveSent: true,
  });
  const gmail = withPreset(formValues(), "gmail");
  assert.equal(gmail.preset, "gmail");
  assert.equal(gmail.imap.host, "imap.gmail.com");
  assert.equal(gmail.saveSent, false);
});

test("a saved account fills the form without its password", () => {
  const values = formValues(saved);
  assert.equal(values.password, "");
  assert.equal(values.username, "support");
  assert.equal(values.imap.host, "imap.example.com");
  // A username equal to the address shows as empty: it defaults to the address.
  assert.equal(
    formValues({ ...saved, imap: { ...saved.imap, username: saved.address } }).username,
    "",
  );
  assert.equal(isDirty(values, formValues(saved)), false);
  assert.equal(isDirty({ ...values, name: "Other" }, formValues(saved)), true);
});

test("the body omits an empty password when editing and sends both servers", () => {
  const values = { ...formValues(saved), password: "" };
  const body = accountBody(values, { editing: true });
  assert.equal(Object.hasOwn(body, "password"), false);
  assert.deepEqual(body, {
    name: "Support",
    address: "support@example.com",
    displayName: "Support team",
    preset: "generic",
    imap: { host: "imap.example.com", port: 993, security: "tls", username: "support" },
    smtp: { host: "smtp.example.com", port: 465, security: "tls", username: "support" },
    allowPlaintext: false,
    saveSent: true,
  });
  const created = accountBody(
    {
      ...values,
      username: "",
      password: "secret-1",
      imap: { ...values.imap, port: "143" },
    },
    { editing: false },
  );
  assert.equal(created.password, "secret-1");
  assert.equal(created.imap.port, 143);
  // An empty username lets the server default it to the address.
  assert.equal(created.imap.username, "");
  assert.equal(created.smtp.username, "");
});

test("an edit sends the username only when it changed", () => {
  // A stored SMTP username that differs from the IMAP one survives an edit.
  const account = { ...saved, smtp: { ...saved.smtp, username: "relay-user" } };
  const initial = formValues(account);
  const renamed = accountBody(
    { ...initial, name: "Renamed" },
    { editing: true, initial },
  );
  assert.equal(Object.hasOwn(renamed.imap, "username"), false);
  assert.equal(Object.hasOwn(renamed.smtp, "username"), false);
  const changed = accountBody(
    { ...initial, username: "new" },
    { editing: true, initial },
  );
  assert.equal(changed.imap.username, "new");
  assert.equal(changed.smtp.username, "new");
  // A new preset drops the stored servers, usernames included: they go along.
  const moved = accountBody(withPreset(initial, "gmail"), { editing: true, initial });
  assert.equal(moved.imap.username, "support");
  assert.equal(testBody({ ...initial, name: "X" }, account).imap.username, undefined);
  // A username that follows the address moves along with a new address.
  const follows = formValues({
    ...saved,
    imap: { ...saved.imap, username: saved.address },
  });
  const readdressed = accountBody(
    { ...follows, address: "help@example.com" },
    { editing: true, initial: follows },
  );
  assert.equal(readdressed.imap.username, "");
});

test("ports compare as numbers in the dirty check", () => {
  const initial = formValues(saved);
  assert.equal(
    isDirty({ ...initial, imap: { ...initial.imap, port: "993" } }, initial),
    false,
  );
  assert.equal(
    isDirty({ ...initial, imap: { ...initial.imap, port: "994" } }, initial),
    true,
  );
});

test("a changed server, port, security or preset needs the password again", () => {
  const values = formValues(saved);
  assert.equal(passwordRequired(values, saved), false);
  assert.equal(passwordRequired({ ...values, username: "other" }, saved), false);
  assert.equal(passwordRequired({ ...values, address: "a@example.com" }, saved), false);
  for (const change of [
    { imap: { ...values.imap, host: "imap.other.com" } },
    { imap: { ...values.imap, port: "143" } },
    { smtp: { ...values.smtp, security: "starttls" } },
  ])
    assert.equal(passwordRequired({ ...values, ...change }, saved), true);
  assert.equal(passwordRequired(withPreset(values, "gmail"), saved), true);
  assert.equal(passwordRequired(formValues(), null), true);
});

test("plaintext needs the owner's consent before it can be saved", () => {
  const values = {
    ...formValues(saved),
    smtp: { ...saved.smtp, security: "none" },
    password: "secret-1",
  };
  assert.equal(needsPlaintext(values), true);
  assert.equal(saveBlocker(values, saved), "plaintext");
  const consented = { ...values, allowPlaintext: true };
  assert.equal(saveBlocker(consented, saved), null);
  assert.equal(accountBody(consented, { editing: true }).allowPlaintext, true);
  // Consent is dropped once no side is plaintext any more.
  assert.equal(
    accountBody(
      { ...consented, smtp: { ...consented.smtp, security: "tls" } },
      { editing: true },
    ).allowPlaintext,
    false,
  );
});

test("save waits for the required fields and a needed password", () => {
  const blank = formValues();
  assert.equal(saveBlocker(blank, null), "incomplete");
  const filled = {
    ...withPreset(blank, "gmail"),
    name: "Me",
    address: "me@gmail.com",
  };
  assert.equal(saveBlocker(filled, null), "password");
  assert.equal(saveBlocker({ ...filled, password: "abcd efgh" }, null), null);
  assert.equal(
    saveBlocker({ ...filled, password: "x", imap: { ...filled.imap, port: "0" } }, null),
    "incomplete",
  );
  const edited = { ...formValues(saved), imap: { ...saved.imap, host: "imap.new.com" } };
  assert.equal(saveBlocker(edited, saved), "password");
});

test("a test of a saved account names it and reuses its password", () => {
  const values = formValues(saved);
  assert.deepEqual(testBody(values, saved), {
    accountId: "acc-1",
    ...accountBody(values, { editing: true, initial: values }),
  });
  const typed = testBody({ ...values, password: "new" }, null);
  assert.equal(typed.accountId, undefined);
  assert.equal(typed.password, "new");
});
