import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";
import { startFakeImap } from "../helpers/fake-imap-server.js";
import { startFakeSmtp } from "../helpers/fake-smtp-server.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const password = "pw-route-secret";
const address = "owner@example.com";

async function mailFixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const users = { [address]: password };
  const imap = await startFakeImap({ security: "tls", users });
  const smtp = await startFakeSmtp({ security: "tls", users });
  t.after(() => Promise.all([imap.close(), smtp.close()]));
  // The CA reaches the store in-process only; no route accepts one.
  f.application.mailAccounts.tlsCa = [imap.ca, smtp.ca];
  const fields = {
    name: "Work",
    address,
    preset: "generic",
    imap: { host: "127.0.0.1", port: imap.port, security: "tls" },
    smtp: { host: "127.0.0.1", port: smtp.port, security: "tls" },
  };
  const send = async (endpoint, method = "GET", body) => {
    const response = await f.request(endpoint, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return { response, status: response.status, text, json: text && JSON.parse(text) };
  };
  return { f, fields, send };
}

const noSecrets = (text) => {
  assert.doesNotMatch(text, /"password"/);
  assert.doesNotMatch(text, /credentialRevision/);
  assert.doesNotMatch(text, /passwords\//);
  assert.ok(!text.includes(password), "the password never leaves the server");
};

test("the owner creates, lists, changes and removes mail accounts without secrets", async (t) => {
  const { fields, send } = await mailFixture(t);
  const created = await send("/api/mail/accounts", "POST", { ...fields, password });
  assert.equal(created.status, 201);
  assert.equal(created.response.headers.get("cache-control"), "no-store");
  noSecrets(created.text);
  assert.equal(created.json.hasPassword, true);
  const id = created.json.id;

  const listed = await send("/api/mail/accounts");
  assert.equal(listed.status, 200);
  assert.equal(listed.response.headers.get("cache-control"), "no-store");
  noSecrets(listed.text);
  assert.deepEqual(
    listed.json.accounts.map((a) => a.id),
    [id],
  );
  assert.equal(listed.json.presets.gmail.imap.host, "imap.gmail.com");
  assert.ok(listed.json.presets.generic);

  const renamed = await send(`/api/mail/accounts/${id}`, "PATCH", { name: "Office" });
  assert.equal(renamed.status, 200);
  noSecrets(renamed.text);
  assert.equal(renamed.json.name, "Office");
  assert.equal(renamed.json.hasPassword, true);

  const moved = await send(`/api/mail/accounts/${id}`, "PATCH", {
    imap: { host: "127.0.0.2" },
  });
  assert.equal(moved.status, 400);
  assert.equal(moved.json.error, serverMessages.mail.passwordRequiredForServer);

  const removed = await send(`/api/mail/accounts/${id}`, "DELETE");
  assert.equal(removed.status, 204);
  assert.equal(removed.response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await send("/api/mail/accounts")).json.accounts, []);
  const gone = await send(`/api/mail/accounts/${id}/test`, "POST", {});
  assert.equal(gone.status, 404);
  assert.equal(gone.json.error, serverMessages.mail.accountNotFound);
});

test("bodies with unknown keys are refused", async (t) => {
  const { fields, send } = await mailFixture(t);
  for (const [endpoint, method, body] of [
    ["/api/mail/accounts", "POST", { ...fields, password, extra: 1 }],
    ["/api/mail/accounts", "POST", [fields]],
    ["/api/mail/test", "POST", { ...fields, password, credentialRevision: "x" }],
  ]) {
    const result = await send(endpoint, method, body);
    assert.equal(result.status, 400, `${method} ${endpoint}`);
    assert.equal(result.json.error, serverMessages.mail.invalidAccount);
  }
  const { json } = await send("/api/mail/accounts", "POST", { ...fields, password });
  const patched = await send(`/api/mail/accounts/${json.id}`, "PATCH", {
    accountId: json.id,
  });
  assert.equal(patched.status, 400);
  assert.equal(patched.json.error, serverMessages.mail.invalidAccount);
});

test("tests run against the servers, typed or with the saved password", async (t) => {
  const { fields, send } = await mailFixture(t);
  const ok = { imap: { ok: true }, smtp: { ok: true } };
  const typed = await send("/api/mail/test", "POST", { ...fields, password });
  assert.equal(typed.status, 200);
  assert.equal(typed.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(typed.json, ok);
  const wrong = await send("/api/mail/test", "POST", { ...fields, password: "nope" });
  assert.equal(wrong.json.imap.ok, false);
  assert.match(wrong.json.imap.code, /^MAIL_/);
  noSecrets(wrong.text);

  const { json: account } = await send("/api/mail/accounts", "POST", {
    ...fields,
    password,
  });
  const reused = await send("/api/mail/test", "POST", {
    accountId: account.id,
    name: "Work",
  });
  assert.deepEqual(reused.json, ok);
  const saved = await send(`/api/mail/accounts/${account.id}/test`, "POST", {});
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, ok);
  const [listed] = (await send("/api/mail/accounts")).json.accounts;
  assert.equal(listed.lastTest.imap, "ok");
  assert.equal(listed.lastTest.smtp, "ok");
});

test("Zugänge counts mail accounts and warns about plaintext ones", async (t) => {
  const { fields, send } = await mailFixture(t);
  const { json: account } = await send("/api/mail/accounts", "POST", {
    ...fields,
    allowPlaintext: true,
    smtp: { ...fields.smtp, security: "none" },
    password,
  });
  const problems = (await send("/api/connections/problems")).json;
  assert.equal(problems.mail.total, 1);
  assert.deepEqual(problems.mail.problems, []);
  assert.deepEqual(problems.mail.warnings, [{ id: account.id, reasons: ["plaintext"] }]);
  const usage = (await send("/api/connections/usage")).json;
  assert.deepEqual(usage.mail, { [account.id]: { agents: [] } });
});

test("restricted users never reach a mail route", async (t) => {
  const { f, fields, send } = await mailFixture(t);
  const { json: account } = await send("/api/mail/accounts", "POST", {
    ...fields,
    password,
  });
  const { cookie } = await signedInUser(f);
  const notFound = await (await f.request("/api/does-not-exist")).json();
  for (const [method, endpoint] of [
    ["GET", "/api/mail/accounts"],
    ["POST", "/api/mail/accounts"],
    ["PATCH", `/api/mail/accounts/${account.id}`],
    ["DELETE", `/api/mail/accounts/${account.id}`],
    ["POST", `/api/mail/accounts/${account.id}/test`],
    ["POST", "/api/mail/test"],
  ]) {
    const response = await f.request(endpoint, {
      method,
      headers: { cookie },
      ...(method === "GET" || method === "DELETE"
        ? {}
        : { body: { ...fields, password } }),
    });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), notFound);
    assert.ok(!text.includes(address), `${method} ${endpoint}`);
  }
  assert.equal((await send("/api/mail/accounts")).json.accounts.length, 1);
});

test("an unreadable account list fails without its content", async (t) => {
  const { f, send } = await mailFixture(t);
  await fs.mkdir(path.join(f.dataDir, "mail"), { recursive: true });
  await fs.writeFile(path.join(f.dataDir, "mail", "accounts.json"), '{"secret-ish": tru');
  const listed = await send("/api/mail/accounts");
  assert.equal(listed.status, 500);
  assert.equal(listed.json.error, serverMessages.mail.catalogUnreadable);
  assert.equal(listed.json.code, "MAIL_CATALOG_UNREADABLE");
  assert.doesNotMatch(listed.text, /secret-ish/);
  assert.equal((await send("/api/connections/problems")).json.mail, null);
  assert.equal((await send("/api/connections/usage")).json.mail, null);
});

test("connection tests share one owner budget per minute", async (t) => {
  const { send } = await mailFixture(t);
  const missing = "/api/mail/accounts/00000000-0000-4000-8000-000000000000/test";
  for (let i = 0; i < 30; i++)
    assert.equal((await send(missing, "POST", {})).status, 404);
  const limited = await send("/api/mail/test", "POST", {});
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, "MAIL_TEST_RATE_LIMITED");
  assert.equal(limited.json.error, serverMessages.mail.testRateLimited);
  assert.equal(limited.response.headers.get("cache-control"), "no-store");
});
