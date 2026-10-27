import test from "node:test";
import assert from "node:assert/strict";
import { agentSshFixture } from "../helpers/agent-ssh-fixture.js";
import {
  mailCatalog,
  recipientAllowed,
} from "../../server/features/assistants/mail/agent-mail-grants.js";
import { AssistantAccess } from "../../server/features/assistants/assistant-access.js";
import { TelegramSenders } from "../../server/features/assistant-channels/telegram-senders.js";

const a = "aaaaaaaa-1111-4111-8111-111111111111";
const b = "bbbbbbbb-2222-4222-8222-222222222222";
const userAccess = {
  mode: "own",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};

/** The SSH fixture plus a stand-in mail account catalog with two accounts. */
async function mailFixture(t) {
  const f = await agentSshFixture(t);
  const accounts = [
    { id: a, name: "Work", address: "work@example.com", hasPassword: true },
    { id: b, name: "Home", address: "me@example.org", hasPassword: true },
  ];
  const mail = { failing: false, accounts };
  f.services.mailAccounts = {
    list() {
      if (mail.failing) throw Object.assign(Error("unreadable"), { status: 500 });
      return mail.accounts.map((x) => ({ ...x }));
    },
  };
  const access = f.workflows.access;
  const save = (mailAccesses, id = f.id, extra = f.policy) =>
    access.save(id, { ...extra, mailAccesses }, access.get(id).revision);
  return { ...f, mail, access, save };
}

const mailAudits = (f) =>
  f.audit.filter(
    (e) => e.action === "assistant.updated" && e.details.kind === "mail-grants",
  );

test("an owner save stores mail grants sorted with normalized rules", async (t) => {
  const f = await mailFixture(t);
  assert.deepEqual(f.access.get(f.id).mailAccesses, []);
  const saved = f.save([
    {
      accountId: b,
      level: "send",
      recipients: ["Bob@Example.com", "example.org", "bob@example.com"],
    },
    { accountId: a, level: "read", recipients: ["x@y.de"] },
  ]);
  const expected = [
    { accountId: a, level: "read", recipients: [] },
    { accountId: b, level: "send", recipients: ["bob@example.com", "example.org"] },
  ];
  assert.deepEqual(saved.mailAccesses, expected);
  assert.deepEqual(f.access.get(f.id).mailAccesses, expected);
  assert.deepEqual(f.access.mailGrant(f.id, b), expected[1]);
  assert.equal(f.access.mailGrant(f.id, "unknown"), null);
  // The audit names account ids and a rule count, never an address.
  const [record] = mailAudits(f);
  assert.deepEqual(record.details, {
    kind: "mail-grants",
    revision: saved.revision,
    added: [a, b],
    removed: [],
    changed: [],
    ruleCount: 2,
    reason: "owner",
  });
  assert.doesNotMatch(JSON.stringify(f.audit), /example\.(com|org)|y\.de/);
  // The Work tab's catalog: id, name and address only.
  assert.deepEqual(f.access.catalog().mailAccounts, [
    { id: a, name: "Work", address: "work@example.com" },
    { id: b, name: "Home", address: "me@example.org" },
  ]);
  f.mail.failing = true;
  assert.equal(mailCatalog(f.services), null);
  assert.equal(f.access.catalog().mailAccounts, null);
});

test("absent mailAccesses keeps the stored grants", async (t) => {
  const f = await mailFixture(t);
  const saved = f.save([{ accountId: a, level: "send", recipients: ["example.com"] }]);
  const kept = f.access.save(f.id, f.policy, saved.revision);
  assert.deepEqual(kept.mailAccesses, saved.mailAccesses);
  // Unreadable catalog: a save without the field still keeps them.
  f.mail.failing = true;
  const again = f.access.save(f.id, f.policy, kept.revision);
  assert.deepEqual(again.mailAccesses, saved.mailAccesses);
  assert.throws(() => f.save([{ accountId: a, level: "read" }]), { status: 503 });
  f.mail.failing = false;
  // A changed level and rules are audited as changed; an empty list removes.
  const changed = f.save([{ accountId: a, level: "read" }]);
  assert.deepEqual(changed.mailAccesses, [
    { accountId: a, level: "read", recipients: [] },
  ]);
  f.save([]);
  assert.deepEqual(f.access.get(f.id).mailAccesses, []);
  const records = mailAudits(f).map((e) => e.details);
  assert.deepEqual(
    records.map(({ added, removed, changed: c }) => [added, removed, c]),
    [
      [[a], [], []],
      [[], [], [a]],
      [[], [a], []],
    ],
  );
});

test("an unknown account is refused with 409", async (t) => {
  const f = await mailFixture(t);
  assert.throws(() => f.save([{ accountId: "nope", level: "read" }]), {
    status: 409,
    key: "mailAccountUnavailable",
  });
  const many = Array.from({ length: 21 }, (_, n) => ({
    accountId: `acc-${n}`,
    level: "read",
  }));
  const rules = Array.from({ length: 51 }, (_, n) => `u${n}@example.com`);
  for (const value of [
    "all",
    many,
    [{ accountId: a, level: "write" }],
    [{ accountId: a }],
    [{ accountId: a, level: "read", extra: 1 }],
    [
      { accountId: a, level: "read" },
      { accountId: a, level: "send" },
    ],
    [{ accountId: a, level: "send", recipients: rules }],
    [{ accountId: a, level: "send", recipients: "example.com" }],
    [{ accountId: a, level: "send", recipients: ["not a domain"] }],
    [{ accountId: a, level: "send", recipients: ["a@b@example.com"] }],
    [{ accountId: a, level: "send", recipients: ["@example.com"] }],
    [{ accountId: a, level: "send", recipients: ["Bob <bob@example.com>"] }],
    [{ accountId: a, level: "send", recipients: ["*.example.com"] }],
    [{ accountId: a, level: "send", recipients: [""] }],
  ])
    assert.throws(
      () => f.save(value),
      { status: 400 },
      JSON.stringify(value).slice(0, 80),
    );
  assert.equal(f.access.get(f.id).revision, 0);
  assert.equal(mailAudits(f).length, 0);
});

test("a user agent and a temporary member can never hold mail", async (t) => {
  const f = await mailFixture(t);
  const task = f.member({ lifetime: "task" });
  assert.throws(() => f.save([{ accountId: a, level: "read" }], task.id, {}), {
    status: 403,
  });
  assert.equal(f.access.mailGrant(task.id, a), null);
  // A permanent member is the owner's own agent and may hold mail.
  const permanent = f.member({ lifetime: "permanent", name: "Keeper" });
  f.save([{ accountId: a, level: "read" }], permanent.id, {
    projectIds: [],
    pipelineIds: [],
    memoryWrite: false,
    autonomous: false,
    publish: false,
  });
  assert.equal(f.access.mailGrant(permanent.id, a).level, "read");
  // A temporary member never uses its lead's grants.
  f.save([{ accountId: a, level: "send" }]);
  assert.equal(f.access.mailGrant(task.id, a), null);
  // A user agent is refused server-side and never reads a stored grant.
  const body = { ...f.store.storedAssistant(f.id), userAccess };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  assert.throws(
    () =>
      f.access.save(
        f.id,
        {
          ...f.policy,
          projectIds: [],
          pipelineIds: [],
          memoryWrite: false,
          mailAccesses: [{ accountId: a, level: "read" }],
        },
        f.access.get(f.id).revision,
      ),
    { code: "USER_AGENT_LOCKED" },
  );
  assert.equal(f.access.mailGrant(f.id, a), null);
});

test("an agent with Telegram for other people cannot get mail, nor connect such a bot while holding it", async (t) => {
  const f = await mailFixture(t);
  f.services.assistantTelegramSenders = { connected: (id) => id === f.id };
  assert.throws(() => f.save([{ accountId: a, level: "read" }]), {
    status: 409,
    key: "telegramSendersMail",
  });
  delete f.services.assistantTelegramSenders;
  f.save([{ accountId: a, level: "read" }]);
  // The bot service refuses an agent that holds mail (its default predicate reads
  // the access policy).
  const senders = new TelegramSenders({
    store: { get: () => null },
    assistants: { store: f.store, workflows: f.workflows, runtime: {} },
    stdioAgents: () => new Set(),
    sshAgents: () => new Set(),
    secretsGranted: () => false,
    configured: () => new Set(),
  });
  assert.throws(() => senders.eligible(f.id), {
    status: 409,
    key: "telegramSendersMail",
  });
  f.save([]);
  assert.equal(senders.eligible(f.id).id, f.id);
});

test("revokeMail removes the account from every agent and audits mail-grants without addresses", async (t) => {
  const f = await mailFixture(t);
  const permanent = f.member({ lifetime: "permanent", name: "Keeper" });
  f.save([
    { accountId: a, level: "send", recipients: ["boss@example.com"] },
    { accountId: b, level: "read" },
  ]);
  f.save([{ accountId: a, level: "read" }], permanent.id, {
    projectIds: [],
    pipelineIds: [],
    memoryWrite: false,
    autonomous: false,
    publish: false,
  });
  const before = f.access.get(f.id);
  let during = 0;
  const changed = f.access.revokeMail(a, () => during++);
  assert.equal(during, 1);
  assert.deepEqual(changed.sort(), [f.id, permanent.id].sort());
  assert.deepEqual(f.access.get(f.id).mailAccesses, [
    { accountId: b, level: "read", recipients: [] },
  ]);
  assert.deepEqual(f.access.get(permanent.id).mailAccesses, []);
  assert.equal(f.access.mailGrant(f.id, a), null);
  // Pending approvals stay bound to the same approval revision.
  const after = f.access.get(f.id);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.approvalRevision, before.approvalRevision);
  const removals = mailAudits(f).filter((e) => e.details.reason === "account-removed");
  assert.equal(removals.length, 2);
  assert.deepEqual(removals.find((e) => e.resourceId === f.id).details, {
    kind: "mail-grants",
    revision: after.revision,
    added: [],
    removed: [a],
    changed: [],
    ruleCount: 0,
    reason: "account-removed",
  });
  assert.doesNotMatch(JSON.stringify(f.audit), /boss@|example\.com/);
  // Nothing left to revoke; a failing `during` rolls everything back.
  assert.deepEqual(f.access.revokeMail(a), []);
  assert.throws(() =>
    f.access.revokeMail(b, () => {
      throw Error("cards");
    }),
  );
  assert.equal(f.access.mailGrant(f.id, b).level, "read");
});

test("removing a mail account revokes its grants through the store hook", async (t) => {
  const f = await mailFixture(t);
  f.save([{ accountId: a, level: "read" }]);
  // The access policy binds itself to the store it finds (assistant-workflows.js).
  new AssistantAccess(f.services);
  assert.equal(typeof f.services.mailAccounts.onRemoved, "function");
  f.services.mailAccounts.onRemoved(a);
  assert.deepEqual(f.access.get(f.id).mailAccesses, []);
});

test("recipientAllowed matches addresses and exact domains only", () => {
  assert.equal(recipientAllowed(["example.com"], "a@EXAMPLE.com"), true);
  assert.equal(recipientAllowed(["example.com"], "a@evil.example.com"), false);
  assert.equal(recipientAllowed(["example.com"], "a@example.com.evil.net"), false);
  assert.equal(recipientAllowed(["bob+x@example.com"], "BOB+x@example.com"), true);
  assert.equal(recipientAllowed(["bob@example.com"], "bob+x@example.com"), false);
  assert.equal(recipientAllowed([], "bob@example.com"), false);
  assert.equal(recipientAllowed(["example.com"], "example.com"), false);
  assert.equal(recipientAllowed(["example.com"], "a@b@example.com"), false);
  assert.equal(recipientAllowed(["example.com"], '"Bob" <bob@example.com>'), false);
  assert.equal(recipientAllowed(["example.com"], null), false);
});
