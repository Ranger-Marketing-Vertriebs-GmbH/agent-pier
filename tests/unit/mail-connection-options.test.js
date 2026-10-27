import test from "node:test";
import assert from "node:assert/strict";
import {
  imapOptions,
  mailErrorCode,
  smtpOptions,
} from "../../server/features/mail/mail-connection.js";

function account({ security = "tls", port = 993, allowPlaintext = false } = {}) {
  return {
    address: "owner@example.com",
    imap: { host: "imap.example.com", port, security, username: "owner" },
    smtp: { host: "smtp.example.com", port: 465, security, username: "" },
    allowPlaintext,
  };
}

test("implicit TLS validates certificates and never logs", () => {
  const o = imapOptions(account({ security: "tls", port: 993 }), "pw");
  assert.equal(o.secure, true);
  assert.equal(o.tls.rejectUnauthorized, true);
  assert.equal(o.tls.minVersion, "TLSv1.2");
  assert.equal(o.logger, false);
  assert.equal(o.disableAutoIdle, true);
  assert.deepEqual(
    [o.connectionTimeout, o.greetingTimeout, o.socketTimeout],
    [15000, 15000, 60000],
  );
  assert.deepEqual(o.auth, { user: "owner", pass: "pw" });
  const s = smtpOptions(account({ security: "tls" }), "pw");
  assert.equal(s.secure, true);
  assert.equal(s.tls.rejectUnauthorized, true);
  assert.equal(s.tls.minVersion, "TLSv1.2");
  assert.equal(s.logger, false);
  assert.equal(s.debug, false);
  assert.deepEqual(
    [s.connectionTimeout, s.greetingTimeout, s.socketTimeout],
    [15000, 15000, 60000],
  );
});

test("STARTTLS is required, never optional", () => {
  const imap = imapOptions(account({ security: "starttls" }), "pw");
  assert.equal(imap.doSTARTTLS, true);
  assert.equal(imap.secure, false);
  const smtp = smtpOptions(account({ security: "starttls" }), "pw");
  assert.equal(smtp.requireTLS, true);
  assert.equal(smtp.secure, false);
  assert.equal(smtp.tls.rejectUnauthorized, true);
});

test("plaintext needs allowPlaintext", () => {
  assert.throws(() => imapOptions(account({ security: "none" }), "pw"), {
    code: "MAIL_PLAINTEXT_REFUSED",
    key: "mailPlaintextRefused",
  });
  assert.throws(() => smtpOptions(account({ security: "none" }), "pw"), {
    code: "MAIL_PLAINTEXT_REFUSED",
  });
  assert.equal(
    smtpOptions(account({ security: "none", allowPlaintext: true }), "pw").ignoreTLS,
    true,
  );
  const imap = imapOptions(account({ security: "none", allowPlaintext: true }), "pw");
  assert.equal(imap.secure, false);
  assert.equal(imap.doSTARTTLS, false);
});

test("SMTP uses the IMAP username unless its own is set", () => {
  const shared = account();
  assert.equal(smtpOptions(shared, "pw").auth.user, "owner");
  const own = { ...shared, smtp: { ...shared.smtp, username: "sender" } };
  assert.deepEqual(smtpOptions(own, "pw").auth, { user: "sender", pass: "pw" });
});

test("a custom CA and test timeouts are passed through", () => {
  const o = imapOptions(account(), "pw", {
    ca: "CA",
    timeouts: { connection: 1, greeting: 2, socket: 3 },
  });
  assert.equal(o.tls.ca, "CA");
  assert.deepEqual([o.connectionTimeout, o.greetingTimeout, o.socketTimeout], [1, 2, 3]);
  assert.equal(smtpOptions(account(), "pw", { ca: "CA" }).tls.ca, "CA");
  assert.equal(Object.hasOwn(imapOptions(account(), "pw").tls, "ca"), false);
});

test("errors map to mail codes", () => {
  const code = (props) => mailErrorCode(Object.assign(new Error("server text"), props));
  assert.equal(code({ authenticationFailed: true }), "MAIL_AUTH_FAILED");
  assert.equal(code({ code: "EAUTH", responseCode: 535 }), "MAIL_AUTH_FAILED");
  assert.equal(code({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "MAIL_TLS_FAILED");
  assert.equal(
    code({ code: "ESOCKET", originalCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
    "MAIL_TLS_FAILED",
  );
  assert.equal(code({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "MAIL_TLS_FAILED");
  assert.equal(code({ code: "ETLS" }), "MAIL_TLS_FAILED");
  assert.equal(code({ tlsFailed: true }), "MAIL_TLS_FAILED");
  assert.equal(code({ code: "ECONNREFUSED" }), "MAIL_UNREACHABLE");
  assert.equal(code({ code: "ESOCKET", originalCode: "ENOTFOUND" }), "MAIL_UNREACHABLE");
  assert.equal(code({ code: "ETIMEDOUT" }), "MAIL_TIMEOUT");
  assert.equal(code({ code: "GREETING_TIMEOUT" }), "MAIL_TIMEOUT");
  assert.equal(code({ code: "CONNECT_TIMEOUT" }), "MAIL_TIMEOUT");
  assert.equal(code({ code: "ParserError3" }), "MAIL_PROTOCOL");
  assert.equal(code({}), "MAIL_PROTOCOL");
});
