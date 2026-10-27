import test from "node:test";
import assert from "node:assert/strict";
import { mailFixture, mailUser } from "../helpers/agent-mail-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { lockedCall } from "../../server/features/users/user-agent-lock.js";
import { bridgeTool } from "../../server/features/assistants/team-bridge-actions.js";
import { profileTools } from "../../server/features/assistants/native-capabilities.js";

const owner = { role: "owner" };
const userAccess = {
  mode: "own",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};

/** The stable tool code a call fails with. */
async function code(promise) {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("the call succeeded");
}

test("accounts lists only granted, existing accounts with level and rules", async (t) => {
  const f = await mailFixture(t);
  // A second account the agent is not granted.
  f.mailStore.create(
    {
      name: "Other",
      address: "other@example.com",
      preset: "generic",
      imap: { host: "127.0.0.1", port: f.imap.port, security: "tls" },
      smtp: { host: "127.0.0.1", port: f.smtp.port, security: "tls" },
      password: "x",
    },
    owner,
  );
  f.grant("send", ["Bob@Example.com", "example.org"]);
  const expected = [
    {
      accountId: f.account.id,
      name: "Private",
      address: mailUser,
      level: "send",
      recipients: ["bob@example.com", "example.org"],
    },
  ];
  assert.deepEqual(f.workflows.mail.accounts(f.id), expected);
  assert.deepEqual(await f.call(f.ownTurn(), { action: "accounts" }), {
    accounts: expected,
  });
  // A routine run and a hook run with its Email tick list the same.
  assert.deepEqual(await f.call(f.routineTurn(), { action: "accounts" }), {
    accounts: expected,
  });
  assert.deepEqual(await f.call(f.hookTurn(), { action: "accounts" }), {
    accounts: expected,
  });
  // Without the tick, re-read on every call, the hook run is refused.
  f.hook.mail = false;
  assert.equal(
    await code(f.call(f.hookTurn(), { action: "accounts" })),
    "MAIL_ORIGIN_REFUSED",
  );
  // A read grant carries no rules.
  f.grant("read");
  assert.deepEqual(f.workflows.mail.accounts(f.id), [
    { ...expected[0], level: "read", recipients: [] },
  ]);
  // Nothing names the password.
  assert.doesNotMatch(JSON.stringify(f.workflows.mail.accounts(f.id)), /pw-secret/);
});

test("an agent without a grant gets MAIL_NOT_GRANTED", async (t) => {
  const f = await mailFixture(t);
  assert.deepEqual(f.workflows.mail.accounts(f.id), []);
  assert.equal(
    await code(f.call(f.ownTurn(), { action: "accounts" })),
    "MAIL_NOT_GRANTED",
  );
  assert.equal(
    await code(f.call(f.ownTurn(), { action: "list", accountId: f.account.id })),
    "MAIL_NOT_GRANTED",
  );
  // A routine's refusal is noted for its result.
  const routine = f.routineTurn();
  assert.equal(
    await code(f.call(routine, { action: "list", accountId: f.account.id })),
    "MAIL_NOT_GRANTED",
  );
  assert.deepEqual(f.notes, [{ sessionKey: routine.sessionKey, note: "mail_refused" }]);
  // With a grant the gate passes and the mailbox answers.
  f.grant("read");
  const listed = await f.call(f.ownTurn(), { action: "list", accountId: f.account.id });
  assert.deepEqual([listed.messages, listed.untrusted], [[], true]);
  assert.equal(
    await code(f.call(f.ownTurn(), { action: "list", accountId: "unknown" })),
    "MAIL_NOT_GRANTED",
  );
  // An unreadable catalog grants nothing and says the account is unavailable.
  const list = f.mailStore.list;
  f.mailStore.list = () => {
    throw Object.assign(Error("unreadable"), { status: 500 });
  };
  assert.equal(
    await code(f.call(f.ownTurn(), { action: "list", accountId: f.account.id })),
    "MAIL_ACCOUNT_UNAVAILABLE",
  );
  // The account list says so too, instead of claiming no grant.
  assert.equal(
    await code(f.call(f.ownTurn(), { action: "accounts" })),
    "MAIL_ACCOUNT_UNAVAILABLE",
  );
  assert.deepEqual(f.workflows.mail.accounts(f.id), []);
  f.mailStore.list = list;
  // Maintenance answers BUSY before anything else.
  f.assistants.maintenance = { reason: "update" };
  assert.equal(await code(f.call(f.ownTurn(), { action: "accounts" })), "BUSY");
  delete f.assistants.maintenance;
  // An agent with Telegram for other people never reaches mail.
  f.services.assistantTelegramSenders = { connected: (id) => id === f.id };
  assert.equal(
    await code(f.call(f.ownTurn(), { action: "accounts" })),
    "MAIL_NOT_GRANTED",
  );
});

test("a permanent member's lead request turn is refused", async (t) => {
  const f = await mailFixture(t);
  const member = f.member();
  f.grant("read", undefined, member.id);
  for (const kind of ["lead-request", "team-member", "member-result"])
    assert.equal(
      await code(f.call(f.turn(member.conversationId, { kind }), { action: "accounts" })),
      "MAIL_ORIGIN_REFUSED",
      kind,
    );
  // The owner's own chat with the permanent member may use its grant.
  const own = await f.call(f.turn(member.conversationId), { action: "accounts" });
  assert.equal(own.accounts[0].accountId, f.account.id);
  // Forwarded content and a command's completion run never use mail.
  f.grant("read");
  assert.equal(
    await code(
      f.call(f.ownTurn({ kind: "owner", forwarded: true }), { action: "accounts" }),
    ),
    "MAIL_ORIGIN_REFUSED",
  );
  const continuation = { ...f.routineTurn(), routine: null, continuation: { id: "c" } };
  assert.equal(
    await code(f.call(continuation, { action: "accounts" })),
    "MAIL_ORIGIN_REFUSED",
  );
  // A plain goal continuation passes the gate; one carrying a member's result, and a
  // coding session's wake, are refused.
  const goal = { id: "g1", anchorRequestId: "r1", title: "Inbox zero" };
  const continued = await f.call(f.ownTurn({ kind: "owner", goal }), {
    action: "accounts",
  });
  assert.equal(continued.accounts[0].accountId, f.account.id);
  for (const origin of [
    { kind: "owner", goal, result: { kind: "member-result", requestId: "q1" } },
    { kind: "coding-session", sessionId: "s1", state: "idle" },
  ])
    assert.equal(
      await code(f.call(f.ownTurn(origin), { action: "accounts" })),
      "MAIL_ORIGIN_REFUSED",
      JSON.stringify(origin),
    );
  // A temporary member cannot reach mail at all.
  const temporary = f.member({ lifetime: "task", name: "Temp" });
  assert.equal(
    await code(f.call(f.turn(temporary.conversationId), { action: "accounts" })),
    "FORBIDDEN",
  );
});

test("a user agent's call is refused by the bridge lock", async (t) => {
  const f = await mailFixture(t);
  f.grant("read");
  const user = { id: "a", userAccess };
  assert.equal(lockedCall(user, bridgeTool("mail")), true);
  assert.equal(lockedCall({ id: "a" }, bridgeTool("mail")), false);
  assert.ok(!profileTools(user, true, true).includes("agentpier_mail"));
  // A forged body makes it a user agent; AgentMail refuses it as well.
  const body = { ...f.store.storedAssistant(f.id), userAccess };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  assert.equal(
    await code(f.call(f.ownTurn(), { action: "accounts" })),
    "USER_AGENT_LOCKED",
  );
  assert.deepEqual(f.workflows.mail.accounts(f.id), []);
});

test("deleting the account revokes the grant", async (t) => {
  const f = await mailFixture(t);
  f.grant("send", ["example.org"]);
  assert.equal(f.workflows.mail.accounts(f.id).length, 1);
  f.mailStore.remove(f.account.id, owner);
  assert.deepEqual(f.workflows.mail.accounts(f.id), []);
  assert.deepEqual(f.workflows.access.get(f.id).mailAccesses, []);
  assert.equal(
    await code(f.call(f.ownTurn(), { action: "accounts" })),
    "MAIL_NOT_GRANTED",
  );
  // The revocation is audited without addresses.
  const audit = f.audit.filter((e) => e.details?.kind === "mail-grants");
  assert.equal(audit.at(-1).details.reason, "account-removed");
  assert.doesNotMatch(JSON.stringify(audit), /example\.(com|org)/);
  // Closed workflows unbind their hook, so a later removal never reaches them.
  const hook = f.mailStore.onRemoved;
  await f.workflows.mail.close();
  assert.notEqual(f.mailStore.onRemoved, hook);
});

test("the tool input is checked against its schema", async (t) => {
  const f = await mailFixture(t);
  f.grant("read");
  const inv = () => f.ownTurn();
  for (const input of [
    null,
    [],
    { action: "explode" },
    { action: "accounts", extra: true },
    { action: "list", accountId: "" },
    { action: "list", accountId: f.account.id, limit: 0 },
    { action: "list", accountId: f.account.id, limit: 51 },
    { action: "list", accountId: f.account.id, new: "yes" },
    { action: "read", accountId: f.account.id, uid: 0 },
    { action: "mark", accountId: f.account.id, uids: Array(51).fill(1) },
    { action: "mark", accountId: f.account.id, flag: "deleted" },
    { action: "search", accountId: f.account.id, query: { since: "2026-1-1" } },
    { action: "read", accountId: f.account.id, uid: 4294967296 },
    { action: "search", accountId: f.account.id, query: { from: "a", other: "b" } },
    { action: "search", accountId: f.account.id, query: { subject: "x".repeat(201) } },
    { action: "send", accountId: f.account.id, to: Array(51).fill("a@b.de") },
    { action: "send", accountId: f.account.id, subject: "x".repeat(999) },
    { action: "send", accountId: f.account.id, body: "x".repeat(100001) },
  ])
    assert.equal(
      await code(f.call(inv(), input)),
      "INVALID_INPUT",
      JSON.stringify(input),
    );
  assert.equal(
    await code(f.call(inv(), { action: "search", accountId: f.account.id, query: {} })),
    "MAIL_QUERY_EMPTY",
  );
  // Valid input passes the schema and reaches the gate: no grant for this account.
  assert.equal(
    await code(
      f.call(inv(), {
        action: "search",
        accountId: "not-granted",
        query: {
          from: "bob",
          text: "invoice",
          attachment: "pdf",
          since: "2026-10-01",
          unseen: true,
          hasAttachment: true,
        },
        limit: 50,
      }),
    ),
    "MAIL_NOT_GRANTED",
  );
});
