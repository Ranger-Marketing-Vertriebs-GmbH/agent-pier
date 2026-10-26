import test from "node:test";
import assert from "node:assert/strict";
import {
  mayPropose,
  proposalFields,
  proposalLimit,
  proposalTurn,
  sshProposalCaps,
} from "../../server/features/assistants/agent-ssh-proposals.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

const valid = {
  action: "propose",
  name: "Backup NAS",
  host: "NAS-01.example.test",
  port: 2222,
  username: "backup",
  purpose: "Check the nightly backup logs.",
};

test("a proposal's fields are checked like an owner's host and normalised", () => {
  assert.deepEqual(proposalFields(valid), {
    name: "Backup NAS",
    host: "nas-01.example.test",
    port: 2222,
    username: "backup",
    purpose: "Check the nightly backup logs.",
    projectId: null,
  });
  // The port defaults to 22; an IPv6 address is kept in its canonical form.
  const { port: _port, ...noPort } = valid;
  assert.equal(proposalFields(noPort).port, 22);
  assert.equal(proposalFields({ ...valid, host: "2001:DB8::1" }).host, "2001:db8::1");
  assert.equal(proposalFields({ ...valid, projectId: "p-1" }).projectId, "p-1");
});

test("hosts, ports and users that could reach ssh as options or text are refused", () => {
  const invalid = { key: "sshProposalInvalid", status: 400 };
  for (const host of [
    "-oProxyCommand=touch /tmp/x",
    "-p",
    "host name",
    "host;rm -rf /",
    "user@host",
    "host:22",
    "$(id)",
    "a".repeat(254),
    "",
    "bad..dots",
    "trailing-.example",
  ])
    assert.throws(() => proposalFields({ ...valid, host }), invalid, host);
  for (const port of [0, 65536, -1, 22.5, "22a", "0x16", null, true])
    assert.throws(() => proposalFields({ ...valid, port }), invalid, String(port));
  for (const username of [
    "-l",
    "-oProxyCommand=x",
    "root;id",
    "root user",
    "a".repeat(65),
    "",
    "röot",
  ])
    assert.throws(() => proposalFields({ ...valid, username }), invalid, username);
  const { username: _user, ...noUser } = valid;
  assert.throws(() => proposalFields(noUser), invalid);
  // A name is one line of at most 100 characters.
  for (const name of [
    "two\nlines",
    "",
    "x".repeat(101),
    "Zab\u2028bix",
    "Zab\u0085",
    "a\rb",
  ])
    assert.throws(() => proposalFields({ ...valid, name }), invalid);
});

test("purpose, project and unknown keys are refused when malformed", () => {
  const invalid = { key: "invalid", status: 400 };
  for (const purpose of [undefined, "", " ", "x".repeat(1001), "bell\u0007", "nul\0"])
    assert.throws(() => proposalFields({ ...valid, purpose }), invalid, String(purpose));
  // Line breaks are fine in a purpose.
  assert.equal(proposalFields({ ...valid, purpose: "a\nb" }).purpose, "a\nb");
  for (const projectId of ["", 7, "x".repeat(101)])
    assert.throws(() => proposalFields({ ...valid, projectId }), invalid);
  for (const extra of [
    { keyId: "k" },
    { hostKey: "ssh-ed25519 AAAA" },
    { mode: "trusted" },
  ])
    assert.throws(() => proposalFields({ ...valid, ...extra }), invalid);
  assert.throws(() => proposalFields(null), invalid);
});

test("proposals are limited per agent: two waiting, five per hour", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const waiting = { state: "awaiting_approval", expiresAt: now + 1000 };
  const limited = { key: "sshProposalLimit", status: 429 };
  assert.deepEqual(sshProposalCaps, { open: 2, perHour: 5 });
  assert.doesNotThrow(() => proposalLimit([waiting], [now - 1000], now));
  assert.throws(() => proposalLimit([waiting, waiting], [], now), limited);
  // An expired one no longer waits, a decided one neither.
  assert.doesNotThrow(() =>
    proposalLimit(
      [waiting, { ...waiting, expiresAt: now - 1 }, { state: "declined" }],
      [],
      now,
    ),
  );
  const recent = Array.from({ length: 5 }, (_, i) => now - i * 60000);
  assert.throws(() => proposalLimit([], recent, now), limited);
  // Older than an hour does not count.
  assert.doesNotThrow(() => proposalLimit([], [...recent.slice(1), now - 3600000], now));
  assert.equal(toolError(limited).code, "SSH_PROPOSAL_LIMIT");
  assert.match(toolError(limited).reason, /in the last hour/);
});

test("only own agents and permanent members without a bot for others may propose", () => {
  const own = { id: "a" };
  assert.equal(mayPropose(own), true);
  assert.equal(mayPropose({ id: "m", teamMemberId: "t", lifetime: "permanent" }), true);
  assert.equal(mayPropose({ id: "m", teamMemberId: "t", lifetime: "task" }), false);
  assert.equal(mayPropose({ id: "x", archivedAt: "2026-10-01" }), false);
  assert.equal(mayPropose({ id: "u", userAccess: { userId: "user-1" } }), false);
  assert.equal(mayPropose(own, true), false);
});

// A stand-in for the workflows: one turn whose recorded context is `origin`.
function turnOf(origin, agent = { id: "a" }, senders = false) {
  const w = {
    s: { assistantTelegramSenders: { connected: () => senders } },
    a: {
      ledger: {
        getAttempt: () => ({ requestId: "r" }),
        getRequest: () => ({ id: "r", conversationId: "c" }),
      },
      store: {
        getConversation: () => ({ id: "c", assistantId: agent.id }),
        getAssistant: () => agent,
      },
      teams: { store: { context: () => origin } },
    },
  };
  return (inv = {}) => proposalTurn(w, { attemptId: "attempt", ...inv });
}

test("only a turn of the owner's own message may propose", () => {
  const ownerOnly = { key: "sshProposalOwnerOnly", status: 403 };
  for (const origin of [
    { kind: "owner", forwarded: true },
    { kind: "telegram", forwarded: true },
    { kind: "member-result" },
    { kind: "lead-request", requestId: "x" },
    { kind: "team-member" },
    { kind: "memory-step" },
    { kind: "ssh-result" },
    { kind: "ssh-access-result" },
    { kind: "owner", goal: { id: "g", anchorRequestId: "r", title: "Ship" } },
    undefined,
  ])
    assert.throws(() => turnOf(origin)(), ownerOnly, JSON.stringify(origin));
  // Routine and hook runs and command completions have no owner turn.
  const owner = turnOf({ kind: "owner" });
  for (const inv of [
    { attemptId: null },
    { routine: { binding: { id: "b" } } },
    { hook: { event: { id: "e" } } },
    { continuation: { attemptId: "x" } },
  ])
    assert.throws(() => owner(inv), ownerOnly, JSON.stringify(inv));
  assert.equal(owner().agent.id, "a");
  assert.equal(turnOf({ kind: "telegram", chatId: 1 })().origin.kind, "telegram");
  // A temporary member, or an agent with a bot for other people, never proposes.
  const unavailable = { key: "sshProposalUnavailable", status: 403 };
  assert.throws(
    () => turnOf({ kind: "owner" }, { id: "m", teamMemberId: "t", lifetime: "task" })(),
    unavailable,
  );
  assert.throws(() => turnOf({ kind: "owner" }, { id: "a" }, true)(), unavailable);
  assert.equal(toolError(unavailable).code, "SSH_PROPOSAL_UNAVAILABLE");
  assert.equal(toolError(ownerOnly).code, "SSH_PROPOSAL_OWNER_ONLY");
});
