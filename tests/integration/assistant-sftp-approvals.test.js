import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { sftpHostId, waitFor } from "../helpers/agent-ssh-fixture.js";
import { PASSWORD, code, setup, until } from "../helpers/agent-sftp-fixture.js";
import { tree } from "../helpers/sftp-transfer-fixture.js";

const owner = { kind: "owner", channel: "ui" };
const telegram = (f) => ({
  kind: "telegram",
  channelId: f.channel.id,
  chatId: "42",
  userId: "42",
});
const card = (f) =>
  f.workflows.store
    .list(f.id)
    .find((a) => a.payload.action === "sftp" && a.state === "awaiting_approval");
const decide = (f, a, decision, origin = owner) =>
  f.workflows.decide(
    a.id,
    { decision, revision: f.workflows.get(a.id).revision },
    origin,
  );
const read = (f, relative) => fs.readFileSync(path.join(f.server.root, relative), "utf8");

// An agent with an `approval` SFTP grant, a site in its workspace that adds one file
// and overwrites another on the server.
async function approvalFixture(t, { mode = "approval", holdMs = 5000 } = {}) {
  const f = await setup(t);
  f.sftp.approvals.pollMs = 20;
  f.sftp.approvals.holdMs = holdMs;
  f.access([{ accessId: sftpHostId, mode }]);
  f.file(f.workspace, "site/index.html", "<h1>new</h1>");
  f.file(f.workspace, "site/about.html", "<p>about v2</p>");
  f.file(f.server.root, "www/about.html", "<p>about v1</p>");
  return f;
}
const upload = (f, inv = f.ownTurn()) =>
  f.sftpCall(inv, { action: "upload", localPath: "site", remotePath: "/www" });

test("approval-mode upload creates a card with files, bytes and overwrites", async (t) => {
  const f = await approvalFixture(t, { holdMs: 100 });
  const result = await upload(f);
  assert.equal(result.status, "awaiting_approval");
  const a = f.workflows.get(result.actionId);
  assert.equal(a.state, "awaiting_approval");
  assert.equal(a.key.startsWith("sftp:"), true);
  const p = a.payload;
  assert.equal(p.action, "sftp");
  assert.equal(p.trusted, false);
  assert.equal(p.operation, "upload");
  assert.equal(p.hostName, "site");
  assert.equal(p.username, "deploy");
  assert.equal(p.port, f.server.port);
  assert.equal(p.hostFingerprint, "SHA256:site");
  assert.equal(p.remotePath, "/www");
  assert.equal(p.local.path, "site");
  assert.equal(p.originClass, "owner");
  assert.equal(p.connectionRevision, "r1");
  assert.equal(p.summary.files, 2);
  assert.equal(p.summary.bytes, "<h1>new</h1><p>about v2</p>".length);
  assert.equal(p.summary.overwrites, 1);
  assert.deepEqual(p.summary.create, ["index.html"]);
  assert.deepEqual(p.summary.update, ["about.html"]);
  assert.equal(p.deletes, 0);
  assert.equal(p.allowAlways, true);
  assert.match(p.planDigest, /^[a-f0-9]{64}$/);
  assert.ok(p.expiresAt > Date.now() + 590000);
  assert.equal(read(f, "www/about.html"), "<p>about v1</p>");
  // A card is pending on the chat feed and counts as waiting.
  assert.ok(f.workflows.pending(f.id).some((x) => x.id === a.id));
  assert.equal(f.workflows.store.awaitingCounts()[f.id].own, 1);
  await decide(f, a, "decline");
});

test("allow once runs it", async (t) => {
  const f = await approvalFixture(t);
  const call = upload(f);
  const a = await waitFor(() => card(f));
  await decide(f, a, "approve");
  const result = await call;
  assert.equal(result.status, "completed");
  assert.equal(result.actionId, a.id);
  assert.equal(result.files, 2);
  assert.deepEqual(tree(path.join(f.server.root, "www")), {
    "about.html": "<p>about v2</p>",
    "index.html": "<h1>new</h1>",
  });
  const row = f.workflows.get(a.id);
  assert.equal(row.state, "completed");
  assert.equal(row.result.files, 2);
  const done = f.sftpAudit().find((e) => e.action === "sftp.completed");
  assert.equal(done.details.authorizedBy, "approval");
  assert.ok(
    f.audit.some((e) => e.action === "assistant.answered" && e.details.kind === "sftp"),
  );
  // The grant still asks next time.
  assert.equal(f.workflows.access.get(f.id).sshAccesses[0].mode, "approval");
  await f.workflows.tick();
  assert.equal(f.followUps.length, 0, "a delivered result needs no follow-up");
  assert.equal(f.workflows.get(a.id).settled, true);
});

test("an approved workspace upload still leaves the guarded entries out", async (t) => {
  const f = await approvalFixture(t);
  f.file(f.workspace, "AGENTS.md", "# prompt");
  f.file(f.workspace, "skills/s/SKILL.md", "skill");
  const call = f.sftpCall(f.ownTurn(), {
    action: "sync",
    direction: "up",
    remotePath: "/mirror",
  });
  const a = await waitFor(() => card(f));
  assert.deepEqual(a.payload.summary.create.sort(), [
    "site/about.html",
    "site/index.html",
  ]);
  // Guarded entries that appear before the approval are not sent either.
  f.file(f.workspace, "attachments/late.pdf", "pdf");
  await decide(f, a, "approve");
  assert.equal((await call).status, "completed");
  assert.deepEqual(Object.keys(tree(path.join(f.server.root, "mirror"))).sort(), [
    "site/about.html",
    "site/index.html",
  ]);
});

test("allow-always switches the grant to trusted and the next upload runs without a card", async (t) => {
  const f = await approvalFixture(t);
  const call = upload(f);
  const a = await waitFor(() => card(f));
  await decide(f, a, "allow-always");
  assert.equal((await call).status, "completed");
  assert.equal(f.workflows.access.get(f.id).sshAccesses[0].mode, "trusted");
  const changed = f.audit.find(
    (e) => e.details.kind === "ssh-grants" && e.details.reason === "always-allow",
  );
  assert.deepEqual(changed.details.modeChanged, [
    { accessId: sftpHostId, from: "approval", to: "trusted" },
  ]);
  f.file(f.workspace, "site/index.html", "<h1>newer</h1>");
  const next = await upload(f);
  assert.equal(next.status, "completed");
  assert.equal(read(f, "www/index.html"), "<h1>newer</h1>");
  assert.equal(f.workflows.get(next.jobId).payload.trusted, true);
  assert.equal(
    f.workflows.store.list(f.id).filter((x) => x.state === "awaiting_approval").length,
    0,
  );
});

test("delete asks even in trusted mode", async (t) => {
  const f = await approvalFixture(t, { mode: "trusted" });
  f.file(f.server.root, "old/a.txt", "a");
  f.file(f.server.root, "old/sub/b.txt", "bb");
  const call = f.sftpCall(f.ownTurn(), {
    action: "delete",
    remotePath: "/old",
    recursive: true,
  });
  const a = await waitFor(() => card(f));
  assert.equal(a.payload.operation, "delete");
  assert.equal(a.payload.deletes, 4);
  assert.equal(a.payload.allowAlways, false);
  assert.deepEqual(a.payload.summary.delete, ["/old/a.txt", "/old/sub/b.txt"]);
  assert.deepEqual(a.payload.summary.deleteDirs, ["/old/sub", "/old"]);
  assert.ok(fs.existsSync(path.join(f.server.root, "old/a.txt")));
  await decide(f, a, "approve");
  assert.equal((await call).status, "completed");
  assert.equal(fs.existsSync(path.join(f.server.root, "old")), false);
  // A sync that deletes extra files asks too.
  f.file(f.server.root, "www/extra.txt", "x");
  const sync = f.sftpCall(f.ownTurn(), {
    action: "sync",
    direction: "up",
    localPath: "site",
    remotePath: "/www",
    deleteExtra: true,
  });
  const s = await waitFor(() => card(f));
  assert.equal(s.payload.deleteExtra, true);
  assert.deepEqual(s.payload.summary.delete, ["extra.txt"]);
  assert.equal(s.payload.allowAlways, false);
  await decide(f, s, "decline");
  assert.equal((await sync).status, "denied");
  assert.equal(read(f, "www/extra.txt"), "x");
});

test("allow-always is refused on a card with deletes", async (t) => {
  const f = await approvalFixture(t);
  f.file(f.server.root, "gone.txt", "g");
  const call = f.sftpCall(f.ownTurn(), { action: "delete", remotePath: "/gone.txt" });
  const a = await waitFor(() => card(f));
  await assert.rejects(decide(f, a, "allow-always"), { status: 400 });
  assert.equal(f.workflows.get(a.id).state, "awaiting_approval");
  assert.equal(f.workflows.access.get(f.id).sshAccesses[0].mode, "approval");
  await decide(f, a, "decline");
  assert.equal((await call).status, "denied");
  assert.equal(read(f, "gone.txt"), "g");
});

test("deny writes nothing", async (t) => {
  const f = await approvalFixture(t);
  const call = upload(f);
  const a = await waitFor(() => card(f));
  const signIns = f.server.authAttempts();
  await decide(f, a, "decline");
  assert.deepEqual(await call, { status: "denied", actionId: a.id });
  assert.equal(read(f, "www/about.html"), "<p>about v1</p>");
  assert.equal(fs.existsSync(path.join(f.server.root, "www/index.html")), false);
  assert.equal(f.server.authAttempts(), signIns);
  assert.deepEqual(f.sftpAudit(), []);
});

test("plan changed between card and approval fails with SFTP_PLAN_CHANGED", async (t) => {
  const f = await approvalFixture(t);
  const call = upload(f);
  const a = await waitFor(() => card(f));
  f.file(f.workspace, "site/extra.html", "<p>late</p>");
  await decide(f, a, "approve");
  const result = await call;
  assert.equal(result.status, "failed");
  assert.equal(result.code, "SFTP_PLAN_CHANGED");
  const row = f.workflows.get(a.id);
  assert.equal(row.state, "failed");
  assert.equal(row.diagnostic, "SFTP_PLAN_CHANGED");
  assert.equal(read(f, "www/about.html"), "<p>about v1</p>");
  assert.equal(fs.existsSync(path.join(f.server.root, "www/index.html")), false);
});

test("edited host cancels the card", async (t) => {
  const f = await approvalFixture(t);
  const call = upload(f);
  const a = await waitFor(() => card(f));
  // A new password or pin changes the connection revision.
  f.catalog.rows.get(sftpHostId).revision = "r2";
  const decided = await decide(f, a, "approve");
  assert.equal(decided.state, "cancelled");
  assert.equal(decided.diagnostic, "ACCESS_CHANGED");
  assert.equal(await code(call), "SSH_REVOKED");
  assert.equal(read(f, "www/about.html"), "<p>about v1</p>");
});

test("removed host cancels open SFTP cards", async (t) => {
  const f = await approvalFixture(t);
  const call = upload(f);
  const a = await waitFor(() => card(f));
  f.catalog.rows.delete(sftpHostId);
  f.workflows.ssh.revokeAccess(sftpHostId);
  const row = f.workflows.get(a.id);
  assert.equal(row.state, "cancelled");
  assert.equal(row.diagnostic, "HOST_REMOVED");
  assert.equal(await code(call), "SSH_REVOKED");
  assert.deepEqual(f.workflows.access.get(f.id).sshAccesses, []);
});

test("a fourth open card is refused", async (t) => {
  const f = await approvalFixture(t);
  const calls = [1, 2, 3].map(() => upload(f));
  await waitFor(
    () =>
      f.workflows.store.list(f.id).filter((a) => a.state === "awaiting_approval")
        .length === 3,
  );
  assert.equal(await code(upload(f)), "SFTP_APPROVAL_LIMIT");
  for (const a of f.workflows.store
    .list(f.id)
    .filter((x) => x.state === "awaiting_approval"))
    await decide(f, a, "decline");
  await Promise.all(calls);
});

test("result after the hold arrives as sftp-result follow-up and is classified with the inherited origin", async (t) => {
  const f = await approvalFixture(t, { holdMs: 100 });
  const result = await upload(f);
  assert.equal(result.status, "awaiting_approval");
  assert.match(result.notice, /separate message/);
  const a = f.workflows.get(result.actionId);
  assert.equal(a.followUp, true);
  await decide(f, a, "approve");
  await until(() => f.workflows.get(a.id).state === "completed");
  await f.workflows.tick();
  assert.equal(f.followUps.length, 1);
  assert.deepEqual(f.followUps[0].context, { kind: "sftp-result", actionId: a.id });
  assert.equal(f.followUps[0].input.clientRequestId, `sftp-result:${a.id}`);
  assert.match(f.followUps[0].input.text, /"status":"completed"/);
  assert.match(f.followUps[0].input.text, /not a new owner instruction/);
  assert.equal(f.workflows.get(a.id).settled, true);
  // The follow-up turn acts with the class of the owner turn it continues.
  const followUp = f.turn(f.channel.conversationId, f.followUps[0].context);
  assert.equal((await f.sftpCall(followUp, { action: "list" })).untrusted, true);
  // Another agent's follow-up turn on this action inherits nothing.
  const member = f.member();
  const forged = f.turn(member.conversationId, f.followUps[0].context);
  assert.equal(f.workflows.ssh.classify(f.workflows.ssh.caller(forged)), "refused");
  await f.workflows.tick();
  assert.equal(f.followUps.length, 1, "sent once");
});

test("a trusted job still running after the hold arrives as a follow-up", async (t) => {
  const f = await approvalFixture(t, { mode: "trusted" });
  f.sftp.holdMs = 50;
  f.file(f.workspace, "big.bin", "x".repeat(65536));
  f.server.stallNext("WRITE");
  const started = await f.sftpCall(f.ownTurn(), {
    action: "upload",
    localPath: "big.bin",
    remotePath: "/big.bin",
  });
  assert.equal(started.status, "running");
  assert.equal(f.workflows.get(started.jobId).settled, false);
  assert.ok(f.workflows.pending(f.id).some((x) => x.id === started.jobId));
  f.catalog.rows.get(sftpHostId).revision = "r2";
  await until(() => f.workflows.get(started.jobId).state === "failed");
  await f.workflows.tick();
  assert.equal(f.followUps.length, 1);
  assert.deepEqual(f.followUps[0].context, {
    kind: "sftp-result",
    actionId: started.jobId,
  });
  assert.match(f.followUps[0].input.text, /SSH_REVOKED/);
  assert.equal(f.workflows.get(started.jobId).settled, true);
});

test("an approved card interrupted by a restart is never run again", async (t) => {
  const f = await approvalFixture(t);
  const call = upload(f);
  const a = await waitFor(() => card(f));
  f.workflows.store.patch(a.id, { state: "executing" });
  new AssistantActionStore(f.store.db);
  assert.equal(f.workflows.get(a.id).state, "unknown");
  assert.equal((await call).status, "unknown");
  await f.workflows.tick();
  assert.equal(f.workflows.get(a.id).settled, true);
  assert.equal(f.followUps.length, 0);
  assert.equal(read(f, "www/about.html"), "<p>about v1</p>");
});

test("Telegram offers Always allow only without deletes and decides only listed plans", async (t) => {
  const f = await approvalFixture(t, { holdMs: 50 });
  const outbox = (id) =>
    f.service.outbox.all().find((e) => e.key === `action-approval:${id}`);
  const { actionId } = await upload(f, f.ownTurn(telegram(f)));
  const entry = outbox(actionId);
  assert.deepEqual(
    entry.actions.map((x) => x.decision),
    ["approve", "allow-always", "decline"],
  );
  assert.match(entry.text, /deploy@127\.0\.0\.1:\d+|deploy@localhost:\d+/);
  assert.match(entry.text, /index\.html/);
  await decide(f, f.workflows.get(actionId), "allow-always", telegram(f));
  await until(() => f.workflows.get(actionId).state === "completed");
  f.file(f.server.root, "gone.txt", "g");
  const removal = await f.sftpCall(f.ownTurn(telegram(f)), {
    action: "delete",
    remotePath: "/gone.txt",
  });
  assert.deepEqual(
    outbox(removal.actionId).actions.map((x) => x.decision),
    ["approve", "decline"],
  );
  await decide(f, f.workflows.get(removal.actionId), "decline", telegram(f));
  // A plan longer than Telegram lists is decided in AgentPier only.
  f.access([{ accessId: sftpHostId, mode: "approval" }]);
  for (let i = 0; i < 25; i++) f.file(f.workspace, `many/f${i}.txt`, String(i));
  const many = await f.sftpCall(f.ownTurn(telegram(f)), {
    action: "upload",
    localPath: "many",
    remotePath: "/many",
  });
  assert.deepEqual(outbox(many.actionId).actions, []);
  await assert.rejects(
    decide(f, f.workflows.get(many.actionId), "approve", telegram(f)),
    { status: 403 },
  );
  await decide(f, f.workflows.get(many.actionId), "decline", telegram(f));
  await f.workflows.tick();
  const result = f.service.outbox
    .all()
    .find((e) => e.key === `action-result:${actionId}`);
  assert.ok(result, "the result reaches the chat");
});

test("card payload, Telegram text and audit never contain the password", async (t) => {
  const f = await approvalFixture(t, { holdMs: 50 });
  f.file(f.server.root, "gone.txt", "g");
  const asked = [
    await upload(f, f.ownTurn(telegram(f))),
    await f.sftpCall(f.ownTurn(telegram(f)), {
      action: "delete",
      remotePath: "/gone.txt",
    }),
  ];
  for (const { actionId } of asked) {
    await decide(f, f.workflows.get(actionId), "approve", telegram(f));
    await until(() => f.workflows.get(actionId).state === "completed");
  }
  await f.workflows.tick();
  const text = JSON.stringify([
    f.workflows.store.list(f.id),
    f.workflows.list(f.id, { delegated: true }),
    f.service.outbox.all(),
    f.audit,
    f.followUps,
  ]);
  assert.equal(text.includes(PASSWORD), false);
  assert.equal(text.includes(f.server.hostKey.split(" ")[1]), false);
});
