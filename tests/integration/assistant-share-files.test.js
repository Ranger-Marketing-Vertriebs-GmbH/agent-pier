import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { ChannelService } from "../../server/features/assistant-channels/channel-service.js";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";
import { SpeechConnections } from "../../server/features/speech/speech-connections.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";
import { fakeBotApi } from "../helpers/assistant-telegram-fakes.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const token = "123456:abcdefghijklmnopqrstuv";

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-share-files-"));
  const workspaces = path.join(dataDir, "workspaces");
  fs.mkdirSync(workspaces);
  const store = new AssistantStore({ dataDir });
  let history = [];
  const client = new EventEmitter();
  client.ready = true;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async (method, params) => {
    if (method === "sessions.send") return { runId: params.idempotencyKey };
    if (method === "chat.history") return { messages: history, hasMore: false };
    if (method === "sessions.messages.subscribe") return {};
    if (method === "agent.wait") return { status: "timeout" };
    if (method === "sessions.describe") return { session: {} };
    assert.fail(method);
  };
  const runtime = new EventEmitter();
  runtime.client = client;
  runtime.close = async () => {};
  runtime.setState = () => {};
  runtime.status = () => ({ availability: "ready" });
  const service = new AssistantService({
    store,
    runtime,
    models: {
      listCapabilities: () => [],
      resolve: () => ({ release() {} }),
      imageInput: () => true,
    },
    config: { apply: async () => {}, reset() {}, workspaces },
  });
  // The trusted turn contexts TeamStore records in the app.
  const contexts = new Map();
  service.teams = {
    assertMemberTurn() {},
    close() {},
    store: {
      context: (id) => contexts.get(id) || { kind: "unknown" },
      recordContext: (id, context) => contexts.set(id, context),
      transaction: (fn) => service.attachments.transaction(fn),
    },
  };
  const audit = [];
  service.audit = { append: (event) => audit.push(event) };
  const api = await fakeBotApi({ [token]: { id: 123456, username: "fixture_bot" } });
  const channels = new ChannelService({
    dataDir,
    assistants: service,
    speech: new SpeechConnections({ dataDir }),
    clientFactory: (secret) => new TelegramClient({ token: secret, apiRoot: api.url }),
  });
  service.shares.channels = channels;
  const bridge = new TeamBridge({ assistants: service, teams: service.teams });
  const connection = await bridge.start();
  t.after(async () => {
    await bridge.close();
    await channels.close();
    await service.close();
    await api.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = store.createAssistant({
    name: "Lead",
    model: { connectionId: "c", modelId: "vision" },
  });
  const chat = store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "lead",
  });
  const created = channels.store.create({
    assistantId: agent.id,
    conversationId: chat.id,
    botId: 123456,
    username: "fixture_bot",
    token,
    language: "en",
  });
  const pair = channels.store.pairing(created.id, created.revision);
  channels.store.acceptPair(created.id, {
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false },
    text: `/start ${pair.code}`,
  });
  const channel = channels.store.get(created.id);
  // The installed plugin's tool, talking to the bridge over HTTP.
  const tools = [];
  plugin.register({
    pluginConfig: connection,
    registerTool: (factory, options) => tools.push({ factory, options }),
    on() {},
  });
  const tool = (profile, conversation) =>
    tools
      .find((entry) => entry.options.name === "agentpier_share_file")
      .factory.create({
        agentId: profile.runtimeAgentId,
        sessionKey: conversation.runtimeSessionKey,
        assertInvocationCurrent() {},
      });
  const file = (profile, name, body) => {
    const target = path.join(workspaces, profile.id, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  const turn = async (conversation, key, context = { kind: "owner" }) => {
    const sent = await service.send(
      conversation.id,
      { clientRequestId: key, text: "Send me the chart" },
      context,
    );
    return sent.attempt;
  };
  const deliver = () =>
    channels.teamOutbox.process(channel.id, new AbortController().signal);
  return {
    service,
    store,
    channels,
    channel,
    api,
    audit,
    agent,
    chat,
    tool,
    file,
    turn,
    deliver,
    workspaces,
    setHistory: (h) => (history = h),
  };
}

const run = async (tool, input) =>
  JSON.parse((await tool.execute(`call-${Math.random()}`, input)).content[0].text);

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
  await run(f.tool(f.agent, f.chat), { path: "report.pdf" });
  await f.deliver();
  await f.deliver();
  const [first, second] = f.api.files(token, 42);
  assert.equal(first.method, "sendPhoto");
  assert.equal(first.params.caption, "Look");
  assert.equal(first.params.photo.name, "chart.png");
  assert.deepEqual(first.params.photo.bytes, png);
  assert.equal(second.method, "sendDocument");
  assert.equal(second.params.caption, undefined);
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
  const folder = path.join(f.workspaces, f.agent.id, "attachments");
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

test("the agent learns why a share was refused, and a full store says so", async (t) => {
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
  // The per-agent quota counts what attachments/ holds.
  const folder = path.join(f.workspaces, f.agent.id, "attachments");
  fs.mkdirSync(folder, { recursive: true });
  for (let n = 0; n < 1000; n++) fs.writeFileSync(path.join(folder, `old-${n}.txt`), "x");
  f.file(f.agent, "note.txt", "hello");
  await assert.rejects(
    run(tool, { path: "note.txt" }),
    /^Error: STORAGE_FULL: .*attachments\//,
  );
  assert.equal(
    (await f.service.history(f.chat.id)).messages.some((m) => m.shared),
    false,
  );
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
    store: { get: () => ({ parentConversationId: f.chat.id }) },
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
  // Both chats show the one copy in the member's workspace.
  const body = await f.service.attachments.content(lead.attachments[0].id);
  assert.equal(body.body.toString(), "# Findings\n");
  await f.deliver();
  assert.deepEqual(
    f.api.files(token, 42).map((c) => [c.method, c.params.document.name]),
    [["sendDocument", "findings.md"]],
  );
});
