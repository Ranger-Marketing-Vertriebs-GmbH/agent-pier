import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { assistantAttachmentRoutes } from "../../server/http/routes/assistant-attachments.js";
import { png, run, shareFixture, token } from "../helpers/agent-share-fixture.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";

const shared = async (f, conversation = f.chat) =>
  (await f.service.history(conversation.id)).messages.filter((m) => m.shared);

test("shares keep their own budget: the oldest go first when full, and after 90 days", async (t) => {
  const f = await shareFixture(t);
  f.service.attachments.shared.limits = { bytes: 1024, files: 2, ttl: 1000 * 60 };
  let clock = Date.now();
  f.service.attachments.now = () => clock;
  for (const name of ["a.txt", "b.txt", "c.txt"]) f.file(f.agent, name, name);
  await f.turn(f.chat, "budget");
  const tool = f.tool(f.agent, f.chat);
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await run(tool, { path: name });
    clock += 1000;
  }
  // Two files fit: the first gave way to the third and says so in the chat.
  const files = await shared(f);
  assert.deepEqual(
    files.map((m) => [m.unavailable === true, m.attachments.map((x) => x.name)]),
    [
      [true, []],
      [false, ["b.txt"]],
      [false, ["c.txt"]],
    ],
  );
  assert.equal(fs.readdirSync(path.join(f.shares, f.agent.id)).length, 2);
  // Owner uploads keep their own quota beside the shares.
  const upload = await f.service.attachments.stage(f.chat.id, "photo.png", png);
  assert.equal(upload.type, "image/png");
  // Past their time the copies are no longer served, and the sweep removes them.
  const id = files[2].attachments[0].id;
  clock += 1000 * 60;
  await assert.rejects(f.service.attachments.content(id), { status: 404 });
  assert.ok((await shared(f)).every((m) => m.unavailable));
  await f.service.attachments.shared.sweep();
  assert.deepEqual(fs.readdirSync(path.join(f.shares, f.agent.id)), []);
});

test("the owner deletes a shared file from either chat it shows in", async (t) => {
  const f = await shareFixture(t);
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
    store: { get: () => ({ parentConversationId: f.chat.id }) },
  };
  f.file(member, "findings.md", "# Findings\n");
  await f.turn(memberChat, "lead-task", {
    kind: "lead-request",
    requestId: "lead-request-1",
    leadAssistantId: f.agent.id,
    leadName: "Lead",
    display: "Look around",
  });
  await run(f.tool(member, memberChat), { path: "findings.md" });
  const app = express();
  app.use(
    "/api",
    assistantAttachmentRoutes({
      assistants: {
        admit: (fn) => fn(),
        attachments: f.service.attachments,
        changed() {},
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const remove = (conversationId, fileId) =>
    fetch(
      `http://127.0.0.1:${server.address().port}/api/assistant-conversations/${conversationId}/shared-files/${fileId}`,
      { method: "DELETE" },
    );
  const [inLead] = await shared(f);
  // Only the chat that shows the file deletes it.
  assert.equal((await remove(memberChat.id, inLead.attachments[0].id)).status, 404);
  assert.equal((await remove(f.chat.id, inLead.attachments[0].id)).status, 204);
  assert.equal((await remove(f.chat.id, inLead.attachments[0].id)).status, 404);
  for (const chat of [f.chat, memberChat]) {
    const [message] = await shared(f, chat);
    assert.equal(message.unavailable, true);
    assert.deepEqual(message.attachments, []);
  }
  assert.deepEqual(fs.readdirSync(path.join(f.shares, member.id)), []);
  // The member's own file in its workspace stays.
  assert.ok(fs.existsSync(path.join(f.workspaces, member.id, "findings.md")));
});

test("a routine's run shares into its chat and the Telegram chat it delivers to", async (t) => {
  const f = await shareFixture(t);
  const agent = f.store.getAssistant(f.agent.id);
  f.store.updateAssistant(
    agent.id,
    { capabilities: { memory: false, reminders: true } },
    agent.revision,
  );
  const runKey = `agent:${agent.runtimeAgentId}:cron:job-1:run:run-7`;
  const binding = {
    id: "binding-1",
    source: {
      channelId: f.channel.id,
      chatId: f.channel.chatId,
      userId: f.channel.userId,
    },
  };
  f.service.routines = {
    runOrigin: (profile, sessionKey) =>
      profile.id === agent.id && sessionKey === runKey
        ? { binding, conversation: f.chat }
        : null,
    results: { forConversation: () => [] },
  };
  f.file(f.agent, "weekly.png", png);
  const tools = [];
  plugin.register({
    pluginConfig: f.connection,
    registerTool: (factory, options) => tools.push({ factory, options }),
    on() {},
  });
  const create = (sessionKey) =>
    tools
      .find((entry) => entry.options.name === "agentpier_share_file")
      .factory.create({
        agentId: agent.runtimeAgentId,
        sessionKey,
        assertInvocationCurrent() {},
      });
  const result = await run(create(runKey), { path: "weekly.png", caption: "Weekly" });
  assert.equal(result.telegram, "queued");
  const [message] = await shared(f);
  assert.equal(message.text, "Weekly");
  const row = f.service.attachments.db
    .prepare("SELECT request_id FROM agent_attachments")
    .get();
  assert.equal(row.request_id, "share:routine:run-7");
  await f.deliver();
  const [upload] = f.api.files(token, 42);
  assert.deepEqual([upload.method, upload.params.caption], ["sendPhoto", "Weekly"]);
  // Any other session without a turn shares nothing.
  await assert.rejects(
    run(create(`agent:${agent.runtimeAgentId}:cron:job-2`), { path: "weekly.png" }),
    /FORBIDDEN/,
  );
});
