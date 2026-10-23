import test from "node:test";
import assert from "node:assert/strict";
import { conversationHistory } from "../../server/features/assistants/conversations.js";
import { agentSshFixture, hostId, waitFor } from "../helpers/agent-ssh-fixture.js";
import { commandDigest } from "../../server/features/assistants/agent-ssh-text.js";

const telegram = (f) => ({
  kind: "telegram",
  channelId: f.channel.id,
  chatId: "42",
  userId: "42",
});
const notes = async (f) =>
  (await conversationHistory(f.assistants, f.channel.conversationId)).messages.filter(
    (m) => m.event === "ssh-run",
  );

test("trusted runs leave one note each, in order, and never notify", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  await f.execute(f.ownTurn(telegram(f)), "process.exit(0)");
  await f.execute(f.ownTurn(), "process.exit(1)");
  await f.execute(f.ownTurn(), "setTimeout(() => {}, 5000)", hostId, {
    timeoutSeconds: 1,
  });
  const found = await notes(f);
  assert.deepEqual(
    found.map((n) => [n.hostName, n.commandPreview, n.command, n.outcome]),
    [
      ["opnsense", "process.exit(0)", "process.exit(0)", "done"],
      ["opnsense", "process.exit(1)", "process.exit(1)", "exit"],
      [
        "opnsense",
        "setTimeout(() => {}, 5000)",
        "setTimeout(() => {}, 5000)",
        "timedOut",
      ],
    ],
  );
  assert.deepEqual(
    found.slice(0, 2).map((n) => n.exitCode),
    [0, 1],
  );
  assert.ok(found[0].timestamp <= found[1].timestamp);
  assert.ok(Number.isInteger(found[0].durationMs));
  assert.equal(f.service.outbox.all().length, 0);
  assert.deepEqual(f.workflows.store.awaitingCounts(), {});
});

test("a note carries the full command a run's preview cuts", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  const command = `// ${"x".repeat(120)}\nprocess.exit(0)`;
  await f.execute(f.ownTurn(), command);
  const [note] = await notes(f);
  assert.equal(note.command, command);
  assert.equal(note.commandCut, undefined);
  assert.ok(note.commandPreview.endsWith("…"));
  assert.ok(Array.from(note.commandPreview).length <= 80);
});

test("an approved run leaves a note, a denied one does not", async (t) => {
  const f = await agentSshFixture(t);
  f.workflows.ssh.approvals.pollMs = 20;
  f.grant([{ accessId: hostId, mode: "approval" }]);
  const decideNext = async (decision) => {
    const a = await waitFor(() =>
      f.workflows.store.list(f.id).find((x) => x.state === "awaiting_approval"),
    );
    await f.workflows.decide(a.id, { decision, revision: a.revision }, { kind: "owner" });
  };
  const denied = f.execute(f.ownTurn(), "process.exit(0)");
  await decideNext("decline");
  await denied;
  const allowed = f.execute(f.ownTurn(), "process.exit(0)");
  await decideNext("approve");
  await allowed;
  assert.deepEqual(
    (await notes(f)).map((n) => [n.outcome, n.command]),
    [["done", "process.exit(0)"]],
  );
});

test("Telegram offers Allow once and Deny only for short, visible commands", async (t) => {
  const f = await agentSshFixture(t);
  f.workflows.ssh.approvals.holdMs = 50;
  f.grant([{ accessId: hostId, mode: "approval" }]);
  // Outbox entries keep the resolved link, which needs the channel's address.
  const c = f.service.store.get(f.channel.id);
  f.service.store.write({ ...c, appUrl: "https://pier.example" }, c.revision);
  const ask = async (command) => {
    const { actionId } = await f.execute(f.ownTurn(telegram(f)), command);
    return f.service.outbox.all().find((e) => e.key === `action-approval:${actionId}`);
  };
  const short = await ask("uptime");
  assert.deepEqual(
    short.actions.map((a) => a.decision),
    ["approve", "decline"],
  );
  assert.match(short.text, /uptime/);
  assert.match(short.text, /root@opnsense\.invalid:22/);
  const long = await ask(`echo ${"x".repeat(2000)}`);
  assert.deepEqual(long.actions, []);
  assert.match(long.link.url, /^https:\/\/pier\.example\/agents\/.+\/chats\//);
  const hidden = await ask("ls‮ -la");
  assert.deepEqual(hidden.actions, []);
  assert.equal(hidden.text.includes("‮"), false);
});

test("the Telegram result names the exit code but never the output", async (t) => {
  const f = await agentSshFixture(t);
  f.workflows.ssh.approvals.holdMs = 50;
  f.grant([{ accessId: hostId, mode: "approval" }]);
  const { actionId } = await f.execute(
    f.ownTurn(telegram(f)),
    'process.stdout.write("TOP-SECRET-OUTPUT"); process.exit(2)',
  );
  const action = f.workflows.get(actionId);
  await f.workflows.decide(
    actionId,
    { decision: "approve", revision: action.revision },
    telegram(f),
  );
  await waitFor(() => f.workflows.get(actionId).state === "completed");
  await f.workflows.tick();
  const result = f.service.outbox
    .all()
    .find((e) => e.key === `action-result:${actionId}`);
  assert.match(result.text, /(Exit-Code|exit code) 2/);
  assert.equal(result.text.includes("TOP-SECRET-OUTPUT"), false);
  assert.match(f.followUps[0].input.text, /TOP-SECRET-OUTPUT/);
});

test("Telegram cannot approve a command it could not show in full", async (t) => {
  const f = await agentSshFixture(t);
  f.workflows.ssh.approvals.holdMs = 50;
  f.grant([{ accessId: hostId, mode: "approval" }]);
  for (const command of [`echo ${"x".repeat(2000)}`, "ls‮ -la"]) {
    const { actionId } = await f.execute(f.ownTurn(telegram(f)), command);
    const action = f.workflows.get(actionId);
    await assert.rejects(
      f.workflows.decide(
        actionId,
        { decision: "approve", revision: action.revision },
        telegram(f),
      ),
      { status: 403 },
    );
    assert.equal(f.workflows.get(actionId).state, "awaiting_approval");
    await f.workflows.decide(
      actionId,
      { decision: "decline", revision: action.revision },
      telegram(f),
    );
    assert.equal(f.workflows.get(actionId).state, "declined");
  }
});

// Built at run time so no committed line looks like a credential to the secret scanner.
const AUTH = ["Author", "ization"].join("");
const secretCommand = `process.exit(0) // curl -H "${AUTH}: Bearer ${["s3cr3t", "T0KEN"].join("-")}"`;
const redactedText = `process.exit(0) // curl -H "${AUTH}: Bearer •••"`;

test("a trusted run stores and shows its command with secrets redacted", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  await f.execute(f.ownTurn(), secretCommand);
  const [row] = f.workflows.store.list(f.id).filter((a) => a.payload.action === "ssh");
  assert.equal(row.payload.command, redactedText);
  assert.equal(row.payload.commandRedacted, true);
  assert.equal(JSON.stringify(row).includes("s3cr3t-T0KEN"), false);
  // The digest is still the original's, so the audit correlates as before.
  assert.equal(row.payload.commandSha256, commandDigest(secretCommand));
  const [note] = await notes(f);
  assert.deepEqual(
    [note.command, note.commandRedacted, note.commandPreview.includes("s3cr3t")],
    [redactedText, true, false],
  );
});

test("an approved run runs the exact command and then keeps it redacted", async (t) => {
  const f = await agentSshFixture(t);
  f.workflows.ssh.approvals.pollMs = 20;
  f.grant([{ accessId: hostId, mode: "approval" }]);
  const run = f.execute(f.ownTurn(), secretCommand);
  const a = await waitFor(() =>
    f.workflows.store.list(f.id).find((x) => x.state === "awaiting_approval"),
  );
  // The owner decides on the exact text.
  assert.equal(a.payload.command, secretCommand);
  await f.workflows.decide(
    a.id,
    { decision: "approve", revision: a.revision },
    { kind: "owner" },
  );
  const result = await run;
  assert.equal(result.exitCode, 0);
  const row = f.workflows.get(a.id);
  assert.equal(row.payload.command, redactedText);
  assert.equal(row.payload.commandRedacted, true);
  assert.equal(JSON.stringify(row).includes("s3cr3t-T0KEN"), false);
  const [note] = await notes(f);
  assert.deepEqual([note.command, note.commandRedacted], [redactedText, true]);
});

test("a declined command is kept redacted as well", async (t) => {
  const f = await agentSshFixture(t);
  f.workflows.ssh.approvals.pollMs = 20;
  f.grant([{ accessId: hostId, mode: "approval" }]);
  const run = f.execute(f.ownTurn(), secretCommand);
  const a = await waitFor(() =>
    f.workflows.store.list(f.id).find((x) => x.state === "awaiting_approval"),
  );
  await f.workflows.decide(
    a.id,
    { decision: "decline", revision: a.revision },
    { kind: "owner" },
  );
  await run;
  assert.equal(f.workflows.get(a.id).payload.command, redactedText);
});
