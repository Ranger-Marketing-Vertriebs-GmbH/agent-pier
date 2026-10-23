import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  png,
  run,
  shareFixture as setup,
  token,
} from "../helpers/agent-share-fixture.js";

test("a shared file reaches the chat history as the agent's message, never Telegram for a web turn", async (t) => {
  const f = await setup(t);
  f.file(f.agent, "out/chart.png", png);
  f.file(f.agent, "out/data.csv", "a,b\n1,2\n");
  const attempt = await f.turn(f.chat, "web");
  const shared = await run(f.tool(f.agent, f.chat), {
    path: "out/chart.png",
    caption: "The chart",
  });
  assert.equal(shared.status, "shared");
  assert.deepEqual(shared.file, {
    name: "chart.png",
    type: "image/png",
    size: png.length,
  });
  assert.equal(shared.telegram, undefined);
  const csv = await run(f.tool(f.agent, f.chat), { path: "out/data.csv" });
  assert.deepEqual(csv.file.type, "application/octet-stream");
  f.setHistory([
    {
      role: "user",
      content: "Send me the chart",
      timestamp: Date.now() - 10000,
      idempotencyKey: `${attempt.id}:user`,
      __openclaw: { id: "turn-1" },
    },
    { role: "assistant", content: "Here it is.", timestamp: Date.now() + 10000 },
  ]);
  const page = await f.service.history(f.chat.id);
  const [image, data] = page.messages.filter((m) => m.shared);
  assert.equal(image.role, "assistant");
  assert.equal(image.text, "The chart");
  assert.deepEqual(
    image.attachments.map((x) => [x.name, x.type, x.kind]),
    [["chart.png", "image/png", "image"]],
  );
  assert.deepEqual(
    data.attachments.map((x) => [x.name, x.type, x.kind]),
    [["data.csv", "application/octet-stream", "file"]],
  );
  // The files sit between the owner's turn and the reply; the turn has no files.
  assert.deepEqual(
    page.messages.map((m) => m.role),
    ["user", "assistant", "assistant", "assistant"],
  );
  assert.equal(page.messages[0].attachments, undefined);
  assert.equal(page.requests[0].attachments, undefined);
  assert.equal(JSON.stringify(page).includes(f.workspaces), false);
  // The copies live outside the workspace, where the agent cannot reach them.
  const stored = fs.readdirSync(path.join(f.shares, f.agent.id));
  assert.equal(stored.length, 2);
  assert.ok(stored.some((name) => name.endsWith("-chart.png")));
  const mode = fs.statSync(path.join(f.shares, f.agent.id)).mode & 0o777;
  assert.equal(mode, 0o700);
  assert.equal(fs.existsSync(path.join(f.workspaces, f.agent.id, "attachments")), false);
  // The owner's route serves the image inline and the CSV only as a download.
  const content = await f.service.attachments.content(image.attachments[0].id);
  assert.equal(content.inline, true);
  assert.deepEqual(content.body, png);
  assert.equal(
    (await f.service.attachments.content(data.attachments[0].id)).inline,
    false,
  );
  // A retried delivery of the turn still names no files of its own.
  assert.deepEqual(f.service.attachments.files(attempt.requestId), []);
  await f.deliver();
  assert.deepEqual(f.api.files(token, 42), []);
  assert.deepEqual(
    f.audit.map((e) => [e.action, e.details.kind, e.details.channel]),
    [
      ["assistant.sent", "share", "tool"],
      ["assistant.sent", "share", "tool"],
    ],
  );
});

test("a Telegram turn's shares go to the paired chat as multipart photo and document", async (t) => {
  const f = await setup(t);
  f.file(f.agent, "chart.png", png);
  f.file(f.agent, "report.pdf", "%PDF-1.7\n");
  await f.turn(f.chat, "telegram", {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
    inputId: "input-1",
  });
  const photo = await run(f.tool(f.agent, f.chat), {
    path: "chart.png",
    caption: "Look",
  });
  assert.equal(photo.telegram, "queued");
  // A caption that happens to equal the file name is still the caption.
  await run(f.tool(f.agent, f.chat), { path: "report.pdf", caption: "report.pdf" });
  await f.deliver();
  await f.deliver();
  const [first, second] = f.api.files(token, 42);
  assert.equal(first.method, "sendPhoto");
  assert.equal(first.params.caption, "Look");
  assert.equal(first.params.photo.name, "chart.png");
  assert.deepEqual(first.params.photo.bytes, png);
  assert.equal(second.method, "sendDocument");
  assert.equal(second.params.caption, "report.pdf");
  assert.equal(second.params.document.name, "report.pdf");
  assert.equal(second.params.document.bytes.toString(), "%PDF-1.7\n");
  const sent = f.channels.outbox.all(f.channel.id).filter((e) => e.kind === "file");
  assert.deepEqual(
    sent.map((e) => e.state),
    ["delivered", "delivered"],
  );
  // Delivered files are never sent twice.
  await f.deliver();
  assert.equal(f.api.files(token, 42).length, 2);
});

test("a refused photo goes out as a document, and a file gone from storage is not sent", async (t) => {
  const f = await setup(t);
  f.file(f.agent, "wide.png", png);
  f.file(f.agent, "gone.png", png);
  await f.turn(f.chat, "telegram", {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
    inputId: "input-2",
  });
  await run(f.tool(f.agent, f.chat), { path: "wide.png", caption: "refuse" });
  await f.deliver();
  assert.deepEqual(
    f.api.files(token, 42).map((c) => c.method),
    ["sendPhoto", "sendDocument"],
  );
  await run(f.tool(f.agent, f.chat), { path: "gone.png" });
  const folder = path.join(f.shares, f.agent.id);
  for (const name of fs.readdirSync(folder))
    if (name.endsWith("gone.png")) fs.rmSync(path.join(folder, name));
  await f.deliver();
  assert.equal(f.api.files(token, 42).length, 2);
  const last = f.channels.outbox.all(f.channel.id).at(-1);
  assert.deepEqual(
    [last.state, last.diagnostic],
    ["delivery_failed", "FILE_UNAVAILABLE"],
  );
});

test("the agent learns why a share was refused; full owner uploads never block a share", async (t) => {
  const f = await setup(t);
  await f.turn(f.chat, "refusals");
  const tool = f.tool(f.agent, f.chat);
  fs.writeFileSync(path.join(f.workspaces, "outside.txt"), "secret");
  fs.mkdirSync(path.join(f.workspaces, f.agent.id), { recursive: true });
  fs.symlinkSync(
    path.join(f.workspaces, "outside.txt"),
    path.join(f.workspaces, f.agent.id, "link.txt"),
  );
  await assert.rejects(run(tool, { path: "../outside.txt" }), /^Error: SHARE_OUTSIDE: /);
  await assert.rejects(run(tool, { path: "link.txt" }), /^Error: SHARE_OUTSIDE: /);
  await assert.rejects(run(tool, { path: "missing.txt" }), /^Error: SHARE_NOT_FOUND: /);
  await assert.rejects(run(tool, { path: "x", extra: 1 }), /^Error: INVALID_INPUT: /);
  f.file(f.agent, "big.bin", Buffer.alloc(25 * 1024 * 1024 + 1));
  await assert.rejects(run(tool, { path: "big.bin" }), /^Error: SHARE_TOO_LARGE: /);
  fs.rmSync(path.join(f.workspaces, f.agent.id, "big.bin"));
  // A case the file system does not match is a missing file, never a link.
  f.file(f.agent, "Notes/Plan.md", "plan");
  const cased = await run(tool, { path: "notes/plan.md" }).catch((e) => e);
  if (cased instanceof Error) assert.match(String(cased), /^Error: SHARE_NOT_FOUND: /);
  // Shares have their own store: a full attachments/ quota does not stop them.
  const folder = path.join(f.workspaces, f.agent.id, "attachments");
  fs.mkdirSync(folder, { recursive: true });
  for (let n = 0; n < 1000; n++) fs.writeFileSync(path.join(folder, `old-${n}.txt`), "x");
  f.file(f.agent, "note.txt", "hello");
  assert.equal((await run(tool, { path: "note.txt" })).status, "shared");
  // No share is offered while a restore or update may replace the workspace.
  f.service.maintenance = true;
  await assert.rejects(run(tool, { path: "note.txt" }), /unavailable/);
  f.service.maintenance = false;
});

test("a member's share joins its own chat and its lead's, attributed to the member", async (t) => {
  const f = await setup(t);
  const member = f.store.reserveMember({
    id: "member-1",
    parent: f.agent.id,
    assignment: { name: "Scout", role: "Research", assignment: "Look around" },
    snapshot: { instructions: "Plan", model: { connectionId: "c", modelId: "vision" } },
    teamId: "team-1",
    lifetime: "task",
  });
  const memberChat = f.store.saveConversation({
    assistantId: member.id,
    runtimeSessionKey: "agent:member:task",
  });
  f.service.teams.requests = {
    store: { get: () => ({ parentConversationId: f.chat.id }), list: () => [] },
  };
  f.file(member, "findings.md", "# Findings\n");
  await f.turn(memberChat, "lead-task", {
    kind: "lead-request",
    requestId: "lead-request-1",
    leadAssistantId: f.agent.id,
    leadName: "Lead",
    display: "Look around",
    telegram: {
      channelId: f.channel.id,
      chatId: f.channel.chatId,
      userId: f.channel.userId,
    },
  });
  const shared = await run(f.tool(member, memberChat), { path: "findings.md" });
  assert.equal(shared.telegram, "queued");
  const own = (await f.service.history(memberChat.id)).messages.find((m) => m.shared);
  const lead = (await f.service.history(f.chat.id)).messages.find((m) => m.shared);
  assert.equal(own.from, undefined);
  assert.equal(lead.from, "Scout");
  assert.equal(lead.attachments[0].name, "findings.md");
  // Both chats show the one stored copy of the member's file.
  const body = await f.service.attachments.content(lead.attachments[0].id);
  assert.equal(body.body.toString(), "# Findings\n");
  await f.deliver();
  assert.deepEqual(
    f.api.files(token, 42).map((c) => [c.method, c.params.document.name]),
    [["sendDocument", "findings.md"]],
  );
});
