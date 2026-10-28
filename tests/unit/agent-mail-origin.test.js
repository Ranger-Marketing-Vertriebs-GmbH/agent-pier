import test from "node:test";
import assert from "node:assert/strict";
import {
  mailActions,
  mailOrigin,
  mailPermits,
} from "../../server/features/assistants/mail/agent-mail-origin.js";

const cls = (input) => mailOrigin(input).class;

test("owner, Telegram owner and goal continuations are owner turns", () => {
  assert.equal(cls({ context: { kind: "owner" } }), "owner");
  assert.equal(cls({ context: { kind: "telegram" } }), "owner");
  // A work goal continuation is recorded as an owner turn with a goal marker.
  const goal = { id: "g", anchorRequestId: "r", title: "Inbox zero" };
  assert.equal(cls({ context: { kind: "owner", goal } }), "owner");
  // The follow-up of an owner's mail card continues as the owner.
  assert.equal(cls({ context: { kind: "mail-result" }, inherited: "owner" }), "owner");
  assert.equal(cls({ routine: true }), "routine");
});

test("forwarded, lead requests, team members, member results and users are refused", () => {
  for (const context of [
    { kind: "owner", forwarded: true },
    { kind: "telegram", forwarded: true },
    { kind: "lead-request" },
    { kind: "team-member" },
    { kind: "member-result" },
    { kind: "user", userId: "u1" },
    { kind: "ssh-result" },
    { kind: "reminder" },
    { kind: "unknown" },
    null,
    undefined,
  ])
    assert.equal(cls({ context }), "refused", JSON.stringify(context));
  // A mail-result follow-up inherits only an owner card, never anything else.
  for (const inherited of [null, "routine", "hook", "refused", "delegated"])
    assert.equal(cls({ context: { kind: "mail-result" }, inherited }), "refused");
  // A goal turn carrying a member's result (lead-requests.js goalResult) is no
  // owner turn for mail, nor is a coding session's wake.
  const goal = { id: "g", anchorRequestId: "r", title: "Inbox zero" };
  assert.equal(
    cls({ context: { kind: "owner", goal, result: { kind: "member-result" } } }),
    "refused",
  );
  assert.equal(cls({ context: { kind: "owner", result: {} } }), "refused");
  assert.equal(cls({ context: { kind: "coding-session", sessionId: "s" } }), "refused");
  // A permanent member's lead request stays refused even if asked as an owner.
  assert.equal(cls({ context: { kind: "lead-request" }, inherited: "owner" }), "refused");
});

test("a hook needs its Email tick", () => {
  assert.equal(mailOrigin({ hook: true, hookMail: false }).class, "refused");
  assert.equal(mailOrigin({ hook: true }).class, "refused");
  assert.equal(mailOrigin({ hook: true, hookMail: true }).class, "hook");
  // A hook run is a hook, whatever its recorded context says.
  assert.equal(
    mailOrigin({ hook: true, hookMail: false, context: { kind: "owner" } }).class,
    "refused",
  );
});

test("send without a rule asks, with read level refuses", () => {
  assert.equal(mailPermits("send", "routine", "send", false), "card");
  assert.equal(mailPermits("send", "hook", "send", true), "run");
  assert.equal(mailPermits("read", "owner", "send", true), "refuse");
  assert.equal(mailPermits("read", "routine", "delete", false), "run");
  assert.equal(mailPermits("send", "owner", "send", false), "card");
  assert.equal(mailPermits("send", "owner", "send", true), "run");
  for (const action of ["accounts", "list", "read", "search", "mark", "move", "draft"])
    for (const c of ["owner", "routine", "hook"])
      assert.equal(mailPermits("read", c, action, false), "run", `${c} ${action}`);
  for (const action of ["list", "send", "accounts"])
    assert.equal(mailPermits("send", "refused", action, true), "refuse");
  // Unknown levels and classes refuse.
  assert.equal(mailPermits("admin", "owner", "list", true), "refuse");
  assert.equal(mailPermits("send", "delegated", "list", true), "refuse");
});

test("forward needs the send level like send", () => {
  assert.equal(mailPermits("read", "owner", "forward", true), "refuse");
  assert.equal(mailPermits("send", "owner", "forward", false), "card");
  assert.equal(mailPermits("send", "routine", "forward", true), "run");
  assert.equal(mailPermits("read", "hook", "attachment", false), "run");
  assert.equal(mailPermits("send", "refused", "forward", true), "refuse");
  for (const cls of ["owner", "routine", "hook"])
    for (const ruled of [true, false])
      assert.equal(
        mailPermits("send", cls, "forward", ruled),
        mailPermits("send", cls, "send", ruled),
        `${cls} ${ruled}`,
      );
  assert.ok(mailActions.includes("attachment"));
  assert.ok(mailActions.includes("forward"));
});
