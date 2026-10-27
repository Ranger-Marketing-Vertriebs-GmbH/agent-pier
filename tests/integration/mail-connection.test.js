import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  smtpSend,
  testMailAccount,
  withImap,
} from "../../server/features/mail/mail-connection.js";
import { startFakeImap } from "../helpers/fake-imap-server.js";
import { startFakeSmtp } from "../helpers/fake-smtp-server.js";

const users = { "owner@example.com": "pw-secret" };
const fast = { connection: 1500, greeting: 400, socket: 2000 };

function account(imap, smtp, { security = "tls", allowPlaintext = false } = {}) {
  return {
    address: "owner@example.com",
    imap: { host: "127.0.0.1", port: imap, security, username: "owner@example.com" },
    smtp: { host: "127.0.0.1", port: smtp, security, username: "" },
    allowPlaintext,
  };
}

async function servers(t, security, imapExtra = {}) {
  const imap = await startFakeImap({ security, users, ...imapExtra });
  const smtp = await startFakeSmtp({ security, users });
  t.after(() => Promise.all([imap.close(), smtp.close()]));
  return { imap, smtp };
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a test checks login on IMAP and SMTP over TLS", async (t) => {
  const { imap, smtp } = await servers(t, "tls");
  const result = await testMailAccount(account(imap.port, smtp.port), "pw-secret", {
    ca: imap.ca,
  });
  assert.deepEqual(result, { imap: { ok: true }, smtp: { ok: true } });
});

test("STARTTLS works on both", async (t) => {
  const { imap, smtp } = await servers(t, "starttls");
  const result = await testMailAccount(
    account(imap.port, smtp.port, { security: "starttls" }),
    "pw-secret",
    { ca: imap.ca },
  );
  assert.deepEqual(result, { imap: { ok: true }, smtp: { ok: true } });
});

test("plaintext works only with the owner's flag", async (t) => {
  const { imap, smtp } = await servers(t, "none");
  const refused = await testMailAccount(
    account(imap.port, smtp.port, { security: "none" }),
    "pw-secret",
  );
  assert.deepEqual(refused, {
    imap: { ok: false, code: "MAIL_PLAINTEXT_REFUSED" },
    smtp: { ok: false, code: "MAIL_PLAINTEXT_REFUSED" },
  });
  const allowed = await testMailAccount(
    account(imap.port, smtp.port, { security: "none", allowPlaintext: true }),
    "pw-secret",
  );
  assert.deepEqual(allowed, { imap: { ok: true }, smtp: { ok: true } });
});

test("withImap lists special-use folders and logs out", async (t) => {
  const { imap, smtp } = await servers(t, "tls", {
    authMechanisms: [],
    folders: {
      INBOX: { messages: ["Subject: hi\r\n\r\nhello\r\n"] },
      Trash: { specialUse: "\\Trash", messages: [] },
    },
  });
  // A password with quotes and non-ASCII forces LOGIN to send it as a literal.
  const password = 'p"w ü\\';
  imap.users["owner@example.com"] = password;
  const folders = await withImap(
    account(imap.port, smtp.port),
    password,
    async (client) => (await client.list()).map((f) => [f.path, f.specialUse]),
    { ca: imap.ca },
  );
  assert.deepEqual(folders.sort(), [
    ["INBOX", "\\Inbox"],
    ["Trash", "\\Trash"],
  ]);
  assert.equal(imap.folder("INBOX").messages.length, 1);
  assert.equal(imap.loggedOut, 1);
});

test("a wrong password is MAIL_AUTH_FAILED and the error holds no password", async (t) => {
  const { imap, smtp } = await servers(t, "tls");
  const result = await testMailAccount(account(imap.port, smtp.port), "pw-wrong", {
    ca: imap.ca,
  });
  assert.deepEqual(result, {
    imap: { ok: false, code: "MAIL_AUTH_FAILED" },
    smtp: { ok: false, code: "MAIL_AUTH_FAILED" },
  });
  const error = await withImap(
    account(imap.port, smtp.port),
    "pw-secret-wrong",
    async () => assert.fail("must not run"),
    { ca: imap.ca },
  ).catch((caught) => caught);
  assert.equal(error.code, "MAIL_AUTH_FAILED");
  assert.equal(error.key, "mailAuthFailed");
  assert.equal(error.message, "MAIL_AUTH_FAILED");
  const text = JSON.stringify({ result, error, message: error.message });
  assert.equal(text.includes("pw-secret"), false);
  assert.equal(text.includes("pw-wrong"), false);
  assert.equal(/fake|server|invalid/i.test(text), false);
});

test("an unknown CA is MAIL_TLS_FAILED", async (t) => {
  const { imap, smtp } = await servers(t, "tls");
  const result = await testMailAccount(account(imap.port, smtp.port), "pw-secret");
  assert.deepEqual(result, {
    imap: { ok: false, code: "MAIL_TLS_FAILED" },
    smtp: { ok: false, code: "MAIL_TLS_FAILED" },
  });
});

test("a STARTTLS account fails when the server does not offer STARTTLS", async (t) => {
  const { imap, smtp } = await servers(t, "none");
  const result = await testMailAccount(
    account(imap.port, smtp.port, { security: "starttls" }),
    "pw-secret",
    { ca: imap.ca, timeouts: fast },
  );
  assert.deepEqual(result, {
    imap: { ok: false, code: "MAIL_TLS_FAILED" },
    smtp: { ok: false, code: "MAIL_TLS_FAILED" },
  });
});

test("a closed port is MAIL_UNREACHABLE", async () => {
  const port = await closedPort();
  const result = await testMailAccount(account(port, port), "pw-secret", {
    timeouts: fast,
  });
  assert.deepEqual(result, {
    imap: { ok: false, code: "MAIL_UNREACHABLE" },
    smtp: { ok: false, code: "MAIL_UNREACHABLE" },
  });
});

test("a server that never greets is MAIL_TIMEOUT", async (t) => {
  const silent = await startFakeImap({ security: "none", users, silent: true });
  t.after(() => silent.close());
  const started = Date.now();
  const result = await testMailAccount(
    account(silent.port, silent.port, { security: "none", allowPlaintext: true }),
    "pw-secret",
    { timeouts: fast },
  );
  assert.deepEqual(result, {
    imap: { ok: false, code: "MAIL_TIMEOUT" },
    smtp: { ok: false, code: "MAIL_TIMEOUT" },
  });
  assert.ok(Date.now() - started < 5000);
});

test("smtpSend delivers the raw message to the envelope", async (t) => {
  const { imap, smtp } = await servers(t, "tls");
  const raw = Buffer.from(
    "From: owner@example.com\r\nTo: a@example.org\r\nSubject: Hi\r\n\r\nHello\r\n",
  );
  const result = await smtpSend(
    account(imap.port, smtp.port),
    "pw-secret",
    {
      envelope: { from: "owner@example.com", to: ["a@example.org", "b@example.org"] },
      raw,
    },
    { ca: smtp.ca },
  );
  assert.deepEqual(result, { accepted: 2, rejected: 0 });
  assert.equal(smtp.messages.length, 1);
  assert.deepEqual(smtp.messages[0].envelope, {
    from: "owner@example.com",
    to: ["a@example.org", "b@example.org"],
  });
  assert.match(smtp.messages[0].raw.toString(), /Subject: Hi\r\n\r\nHello/);
});

test("smtpSend maps a refused login without echoing it", async (t) => {
  const { imap, smtp } = await servers(t, "tls");
  const error = await smtpSend(
    account(imap.port, smtp.port),
    "pw-nope",
    {
      envelope: { from: "owner@example.com", to: ["a@example.org"] },
      raw: Buffer.from("x"),
    },
    { ca: smtp.ca },
  ).catch((caught) => caught);
  assert.equal(error.code, "MAIL_AUTH_FAILED");
  assert.equal(JSON.stringify(error).includes("pw-nope"), false);
  assert.equal(smtp.messages.length, 0);
});
