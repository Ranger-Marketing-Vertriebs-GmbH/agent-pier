import test from "node:test";
import assert from "node:assert/strict";
import {
  currentGrant,
  grantAccessBody,
  grantKinds,
  mailGrantableAgents,
  mailLevels,
} from "../../web/features/connections/agent-grants.js";

const policy = {
  revision: 4,
  projectIds: ["p1"],
  pipelineIds: [],
  memoryWrite: false,
  autonomous: false,
  publish: false,
  mailAccesses: [
    { accountId: "a", level: "send", recipients: ["example.com"] },
    { accountId: "b", level: "read", recipients: [] },
  ],
};

test("mail is a grant kind with read and send levels", () => {
  assert.ok(grantKinds.includes("mail"));
  assert.deepEqual(mailLevels, ["read", "send"]);
});

test("a mail grant body changes one account and keeps the other grants", () => {
  const read = grantAccessBody(policy, { kind: "mail", itemId: "a", mode: "read" });
  assert.equal(read.revision, 4);
  assert.deepEqual(read.projectIds, ["p1"]);
  assert.deepEqual(read.mailAccesses, [
    { accountId: "a", level: "read", recipients: [] },
    { accountId: "b", level: "read", recipients: [] },
  ]);
  // Raising keeps no rules from Connections; a held send grant keeps its rules.
  assert.deepEqual(
    grantAccessBody(policy, { kind: "mail", itemId: "b", mode: "send" }).mailAccesses[1],
    { accountId: "b", level: "send", recipients: [] },
  );
  assert.deepEqual(
    grantAccessBody(policy, { kind: "mail", itemId: "a", mode: "send" }).mailAccesses[0],
    { accountId: "a", level: "send", recipients: ["example.com"] },
  );
  assert.deepEqual(
    grantAccessBody(policy, { kind: "mail", itemId: "c", mode: "send" }).mailAccesses.map(
      (g) => g.accountId,
    ),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    grantAccessBody(policy, { kind: "mail", itemId: "a", mode: null }).mailAccesses,
    [{ accountId: "b", level: "read", recipients: [] }],
  );
  // The add field passes `true` without modes; it means read.
  assert.equal(
    grantAccessBody({ revision: 0 }, { kind: "mail", itemId: "a", mode: true })
      .mailAccesses[0].level,
    "read",
  );
  // Other grant fields are left out, so the server keeps them.
  assert.equal("sshAccesses" in read, false);
  assert.equal("secretIds" in read, false);
});

test("the current mail grant is its level", () => {
  assert.equal(currentGrant(policy, { kind: "mail", itemId: "a" }), "send");
  assert.equal(currentGrant(policy, { kind: "mail", itemId: "z" }), null);
  assert.equal(currentGrant({}, { kind: "mail", itemId: "a" }), null);
});

test("agents with a Telegram bot for other people are not offered mail", () => {
  const agents = [
    { id: "a", name: "A" },
    { id: "b", name: "B", telegramSenders: { mode: "allowlist" } },
    { id: "c", name: "C", userAccess: { mode: "own" } },
    { id: "d", name: "D", teamMemberId: "m", lifetime: "task" },
  ];
  assert.deepEqual(
    mailGrantableAgents(agents).map((agent) => agent.id),
    ["a"],
  );
});
