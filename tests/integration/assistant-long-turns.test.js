import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";

// OpenClaw 2026.10.3's chat.history: a page cuts every message text at `maxChars`
// (8000 when the caller passes none) and marks the cut; a message read on its own
// (`messageId`) uses the caller's limit.
const marker = "\n...(truncated)...";
const cutText = (text, max) =>
  text.length > max ? `${text.slice(0, max)}${marker}` : text;
const cut = (content, max) =>
  typeof content === "string"
    ? cutText(content, max)
    : content.map((c) => (c.type === "text" ? { ...c, text: cutText(c.text, max) } : c));
// Long texts: a failing comparison reports lengths and endings, not the texts.
const same = (actual, expected) =>
  assert.ok(
    actual === expected,
    `${actual?.length} chars ending ${JSON.stringify(String(actual).slice(-30))}`,
  );
const long = (lines, last) => `${"a line of the pasted docs\n".repeat(lines)}${last}`;

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-long-turns-"));
  const workspaces = path.join(dataDir, "workspaces");
  fs.mkdirSync(workspaces);
  const store = new AssistantStore({ dataDir });
  const sent = [];
  const reads = [];
  let history = [];
  const client = new EventEmitter();
  client.ready = true;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async (method, params) => {
    if (method === "sessions.send") {
      sent.push(params);
      return { runId: params.idempotencyKey };
    }
    if (method === "chat.history") {
      reads.push(params);
      const max = params.maxChars ?? 8000;
      const shown = params.messageId
        ? history.filter((m) => m.__openclaw?.id === params.messageId)
        : history;
      return {
        messages: shown.map((m) => ({ ...m, content: cut(m.content, max) })),
        hasMore: false,
      };
    }
    if (method === "sessions.messages.subscribe") return {};
    if (method === "agent.wait") return { status: "timeout" };
    if (method === "sessions.describe") return { session: {} };
    assert.fail(method);
  };
  const runtime = new EventEmitter();
  runtime.client = client;
  runtime.close = async () => {};
  runtime.setState = () => {};
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
  t.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const a = store.createAssistant({
    name: "lead",
    model: { connectionId: "c", modelId: "vision" },
  });
  const c = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "lead" });
  const turn = (params, id, timestamp) => ({
    role: "user",
    content: params.message,
    timestamp,
    idempotencyKey: `${params.idempotencyKey}:user`,
    __openclaw: { id, idempotencyKey: `${params.idempotencyKey}:user` },
  });
  return {
    service,
    sent,
    reads,
    c,
    turn,
    setHistory: (h) => (history = h),
    pageReads: () => reads.filter((r) => !r.messageId).length,
    singleReads: () => reads.filter((r) => r.messageId),
  };
}

test("a long owner turn is served whole and linked to its request", async (t) => {
  const { service, sent, c, turn, setHistory, singleReads } = setup(t);
  const text = long(400, "ich glaub ich muss die eh alle migrieren");
  assert.ok(text.length > 9000);
  const result = await service.send(c.id, { clientRequestId: "long", text });
  const reply = `${"A long answer. ".repeat(1500)}The end.`;
  setHistory([
    turn(sent[0], "turn-1", 1000),
    {
      role: "assistant",
      content: [{ type: "text", text: reply }],
      timestamp: 2000,
      __openclaw: { id: "reply-1", runId: sent[0].idempotencyKey },
    },
  ]);
  const page = await service.history(c.id);
  const [user, assistant] = page.messages;
  same(user.text, text);
  assert.equal(user.requestId, result.request.id);
  assert.equal(user.cut, undefined);
  same(assistant.text, reply);
  assert.equal(JSON.stringify(page).includes("(truncated)"), false);
  // Each cut message is read on its own with AgentPier's limit.
  assert.deepEqual(
    singleReads()
      .map((r) => [r.messageId, r.maxChars])
      .sort(),
    [
      ["reply-1", 65536],
      ["turn-1", 65536],
    ],
  );
  // The completed text is kept: the next page needs no single reads.
  await service.history(c.id);
  assert.equal(singleReads().length, 2);
});

test("a message beyond AgentPier's limit is marked cut without OpenClaw's marker", async (t) => {
  const { service, c, setHistory } = setup(t);
  const huge = "b".repeat(70000);
  setHistory([
    {
      role: "assistant",
      content: [{ type: "text", text: huge }],
      timestamp: 1000,
      __openclaw: { id: "huge" },
    },
  ]);
  const [message] = (await service.history(c.id)).messages;
  same(message.text, huge.slice(0, 65536));
  assert.equal(message.cut, true);
});

test("a page reads only a bounded number of cut messages on their own", async (t) => {
  const { service, c, setHistory, singleReads, pageReads } = setup(t);
  setHistory(
    Array.from({ length: 30 }, (_, n) => ({
      role: "assistant",
      content: [{ type: "text", text: `${n} ${"c".repeat(9000)}` }],
      timestamp: 1000 + n,
      __openclaw: { id: `m${n}` },
    })),
  );
  const first = (await service.history(c.id)).messages;
  const reads = singleReads().length;
  assert.ok(reads > 0 && reads < 30, `${reads} single reads`);
  // The newest are completed first; the rest are shown cut until a later page.
  assert.equal(first.at(-1).cut, undefined);
  assert.equal(first.at(-1).text.length, 9003);
  assert.equal(first[0].cut, true);
  assert.equal(first[0].text.length, 8000);
  for (let n = 0; n < 5; n++) await service.history(c.id);
  const later = (await service.history(c.id)).messages;
  assert.ok(later.every((m) => !m.cut && m.text.length > 9000));
  assert.equal(singleReads().length, 30);
  assert.equal(pageReads(), 7);
});

test("files stay on a long turn with attachments", async (t) => {
  const { service, sent, c, turn, setHistory } = setup(t);
  const text = long(400, "and the last line");
  const notes = await service.attachments.stage(c.id, "notes.md", Buffer.from("# x\n"));
  await service.send(c.id, { clientRequestId: "files", text, attachments: [notes.id] });
  setHistory([turn(sent[0], "turn-1", 1000)]);
  const [message] = (await service.history(c.id)).messages;
  same(message.text, text);
  assert.deepEqual(
    message.attachments.map((f) => f.id),
    [notes.id],
  );
});

test("files stay on a turn whose note is cut beyond AgentPier's limit", async (t) => {
  const { service, sent, c, turn, setHistory } = setup(t);
  const text = `${"d".repeat(65500)} end`;
  const notes = await service.attachments.stage(c.id, "notes.md", Buffer.from("# x\n"));
  await service.send(c.id, { clientRequestId: "huge", text, attachments: [notes.id] });
  assert.ok(sent[0].message.length > 65536);
  setHistory([turn(sent[0], "turn-1", 1000)]);
  const [message] = (await service.history(c.id)).messages;
  same(message.text, text);
  assert.equal(message.cut, undefined);
  assert.deepEqual(
    message.attachments.map((f) => f.id),
    [notes.id],
  );
});
