import test from "node:test";
import assert from "node:assert/strict";
import { agentSshFixture, hostId, waitFor } from "../helpers/agent-ssh-fixture.js";
import { commandDigest } from "../../server/features/assistants/agent-ssh-text.js";

// Settled SSH cards keep their command with secrets redacted on every path
// (docs/assistant-gateway.md#agent-ssh-access-2026-10-16).
// Built at run time so no committed line looks like a credential to the secret scanner.
const AUTH = ["Author", "ization"].join("");
const secret = ["s3cr3t", "T0KEN"].join("-");
const command = `process.exit(0) // curl -H "${AUTH}: Bearer ${secret}"`;
const redacted = `process.exit(0) // curl -H "${AUTH}: Bearer •••"`;

async function card(t, origin) {
  const f = await agentSshFixture(t);
  f.workflows.ssh.approvals.holdMs = 50;
  f.grant([{ accessId: hostId, mode: "approval" }]);
  const inv = f.ownTurn(origin?.(f));
  const { actionId } = await f.execute(inv, command);
  return { f, inv, id: actionId };
}
const row = (f, id) => f.workflows.get(id);
function assertRedacted(f, id, state) {
  const a = row(f, id);
  assert.equal(a.state, state);
  assert.equal(a.payload.command, redacted);
  assert.equal(a.payload.commandRedacted, true);
  assert.equal(a.payload.commandSha256, commandDigest(command));
  assert.equal(JSON.stringify(a).includes(secret), false);
}
const decline = (f, id) =>
  f.workflows.decide(
    id,
    { decision: "decline", revision: row(f, id).revision },
    { kind: "owner" },
  );

test("an expired card keeps its command redacted", async (t) => {
  const { f, id } = await card(t);
  assert.equal(row(f, id).payload.command, command);
  f.workflows.store.patch(id, { expiresAt: 0 });
  await f.workflows.tick();
  assertRedacted(f, id, "expired");
});

test("a card a removed host cancels keeps its command redacted", async (t) => {
  const { f, id } = await card(t);
  assert.equal(f.workflows.ssh.approvals.cancelFor(hostId), 1);
  assertRedacted(f, id, "cancelled");
});

test("a run lost to a restart is settled as unknown and redacted", async (t) => {
  const { f, id } = await card(t);
  f.workflows.store.patch(id, { state: "executing" });
  await f.workflows.tick();
  assertRedacted(f, id, "unknown");
});

test("a retry of the same call finds its redacted card", async (t) => {
  const { f, inv, id } = await card(t);
  await decline(f, id);
  assertRedacted(f, id, "declined");
  const again = await f.execute(inv, command);
  assert.equal(again.actionId ?? id, id);
  assert.equal(again.status, "denied");
  await assert.rejects(f.execute(inv, `${command} `), { status: 409 });
});

test("a card from before redaction gets the original's digest when redacted", async (t) => {
  const { f, inv, id } = await card(t);
  const { commandSha256: _drop, ...payload } = row(f, id).payload;
  f.workflows.store.patch(id, { payload });
  await decline(f, id);
  assertRedacted(f, id, "declined");
  assert.equal((await f.execute(inv, command)).status, "denied");
});

test("the Telegram approval text is rewritten with the secret redacted", async (t) => {
  const telegram = (f) => ({
    kind: "telegram",
    channelId: f.channel.id,
    chatId: "42",
    userId: "42",
  });
  const { f, id } = await card(t, telegram);
  const entry = () =>
    f.service.outbox.all().find((e) => e.key === `action-approval:${id}`);
  await waitFor(() => entry());
  assert.equal(entry().text.includes(secret), true);
  await decline(f, id);
  const after = entry();
  assert.equal(JSON.stringify(after).includes(secret), false);
  assert.match(after.text, /Bearer •••/);
  assert.ok(after.parts.length > 0);
});
