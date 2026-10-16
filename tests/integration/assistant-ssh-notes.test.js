import test from "node:test";
import assert from "node:assert/strict";
import { conversationHistory } from "../../server/features/assistants/conversations.js";
import { agentSshFixture, hostId, waitFor } from "../helpers/agent-ssh-fixture.js";

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
    found.map((n) => [n.hostName, n.commandPreview, n.outcome, n.exitCode]),
    [
      ["opnsense", "process.exit(0)", "done", undefined],
      ["opnsense", "process.exit(1)", "exit", 1],
      ["opnsense", "setTimeout(() => {}, 5000)", "timedOut", undefined],
    ],
  );
  assert.ok(found[0].timestamp <= found[1].timestamp);
  assert.ok(Number.isInteger(found[0].durationMs));
  assert.equal(f.service.outbox.all().length, 0);
  assert.deepEqual(f.workflows.store.awaitingCounts(), {});
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
    (await notes(f)).map((n) => n.outcome),
    ["done"],
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
