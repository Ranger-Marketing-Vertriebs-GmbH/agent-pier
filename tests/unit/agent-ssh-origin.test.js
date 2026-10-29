import test from "node:test";
import assert from "node:assert/strict";
import {
  permits,
  sshGrantMode,
  sshModes,
  sshOrigin,
} from "../../server/features/assistants/agent-ssh-origin.js";

const cls = (input) => sshOrigin(input).class;

test("owner chats and the paired Telegram chat are owner turns", () => {
  assert.equal(cls({ context: { kind: "owner" } }), "owner");
  assert.equal(cls({ context: { kind: "telegram", channelId: "c" } }), "owner");
  assert.equal(cls({ context: { kind: "telegram", forwarded: true } }), "refused");
  assert.equal(cls({ context: { kind: "owner", forwarded: true } }), "refused");
});

test("a lead's question or task is delegated only for a permanent member", () => {
  for (const kind of ["lead-request", "team-member"]) {
    assert.equal(cls({ context: { kind }, permanentMember: true }), "delegated");
    assert.equal(cls({ context: { kind }, permanentMember: false }), "refused");
  }
});

test("results, reminders, check-ins and unknown turns are refused", () => {
  for (const kind of [
    "member-result",
    "team-result",
    "coding-result",
    "reminder",
    "heartbeat",
    "unknown",
    undefined,
  ])
    assert.equal(cls({ context: kind ? { kind } : null }), "refused", String(kind));
});

test("a routine run session is the routine class whatever its context says", () => {
  assert.equal(cls({ context: { kind: "owner" }, routine: true }), "routine");
  assert.equal(cls({ context: null, routine: true }), "routine");
});

test("an ssh-result or sftp-result turn keeps the class of the action it continues", () => {
  for (const kind of ["ssh-result", "sftp-result"]) {
    const context = { kind, actionId: "a" };
    assert.equal(cls({ context, inherited: "owner" }), "owner");
    assert.equal(cls({ context, inherited: "delegated" }), "delegated");
    assert.equal(cls({ context, inherited: "routine" }), "refused");
    assert.equal(cls({ context, inherited: null }), "refused");
  }
});

test("permits follows the mode table", () => {
  const table = Object.fromEntries(
    sshModes.map((mode) => [
      mode,
      ["owner", "delegated", "routine", "refused"].map((c) => permits(mode, c)),
    ]),
  );
  // Two modes (owner A15): Trusted also runs in routines and other unattended runs.
  assert.deepEqual(table, {
    approval: ["card", "card", "refuse", "refuse"],
    trusted: ["run", "run", "run", "refuse"],
  });
  assert.equal(permits("always", "owner"), "refuse");
  // The legacy mode never reaches permits: AssistantAccess reads it as trusted.
  assert.equal(permits("routines", "owner"), "refuse");
});

test("a hook run is the hook class and runs only on trusted hosts", () => {
  assert.equal(cls({ context: { kind: "owner" }, hook: true }), "hook");
  assert.equal(cls({ context: null, hook: true, routine: true }), "hook");
  assert.equal(permits("trusted", "hook"), "run");
  assert.equal(permits("approval", "hook"), "refuse");
});

test("sshGrantMode reads the legacy routines mode as trusted and nothing else", () => {
  assert.deepEqual(sshModes, ["approval", "trusted"]);
  assert.equal(sshGrantMode("approval"), "approval");
  assert.equal(sshGrantMode("trusted"), "trusted");
  assert.equal(sshGrantMode("routines"), "trusted");
  for (const mode of ["Routines", "always", "", null, undefined, 1, {}, "__proto__"])
    assert.equal(sshGrantMode(mode), null, String(mode));
});
