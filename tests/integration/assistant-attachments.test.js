import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// ChatAttachmentSchema of OpenClaw 2026.9.8 (dist/sessions-*.mjs) and the closed
// SessionsSendParamsSchema that forwards it to chat.send.
const attachmentFields = [
  "type",
  "mimeType",
  "fileName",
  "origin",
  "content",
  "sizeBytes",
  "durationMs",
  "width",
  "height",
];
const sendFields = [
  "key",
  "agentId",
  "message",
  "mentions",
  "thinking",
  "attachments",
  "timeoutMs",
  "idempotencyKey",
];

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-attachments-"));
  const workspaces = path.join(dataDir, "workspaces");
  fs.mkdirSync(workspaces);
  const store = new AssistantStore({ dataDir });
  const sent = [];
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
  const agent = (name) => {
    const a = store.createAssistant({
      name,
      model: { connectionId: "c", modelId: "vision" },
    });
    return {
      a,
      c: store.saveConversation({ assistantId: a.id, runtimeSessionKey: name }),
    };
  };
  return { service, sent, agent, workspaces, setHistory: (h) => (history = h) };
}

test("a turn with files reaches sessions.send in the shape the pinned Gateway accepts", async (t) => {
  const { service, sent, agent, workspaces, setHistory } = setup(t);
  const { a, c } = agent("lead");
  const photo = await service.attachments.stage(c.id, "photo.png", png);
  const notes = await service.attachments.stage(
    c.id,
    "notes.md",
    Buffer.from("# Plan\n"),
  );
  const result = await service.send(c.id, {
    clientRequestId: "with-files",
    text: "Look at these.",
    attachments: [photo.id, notes.id],
  });
  assert.equal(result.attempt.state, "accepted");
  assert.equal(sent.length, 1);
  const [params] = sent;
  for (const key of Object.keys(params)) assert.ok(sendFields.includes(key), key);
  assert.equal(params.attachments.length, 1);
  for (const key of Object.keys(params.attachments[0]))
    assert.ok(attachmentFields.includes(key), key);
  assert.deepEqual(params.attachments[0], {
    type: "image",
    mimeType: "image/png",
    fileName: "photo.png",
    content: png.toString("base64"),
  });
  const [text, note] = params.message.split("\n\n");
  assert.equal(text, "Look at these.");
  const paths = [...note.matchAll(/^- ("attachments\/[^"]+")/gm)].map((m) =>
    JSON.parse(m[1]),
  );
  assert.equal(paths.length, 2);
  for (const file of paths)
    assert.ok(fs.statSync(path.join(workspaces, a.id, file)).isFile(), file);
  assert.equal(params.message.includes(workspaces), false);

  // The history shows the owner's words and the files, not the agent note.
  setHistory([
    {
      role: "user",
      content: params.message,
      timestamp: Date.now(),
      idempotencyKey: `${params.idempotencyKey}:user`,
      __openclaw: { id: "turn-1" },
    },
    { role: "user", content: params.message, timestamp: Date.now() + 1 },
  ]);
  const page = await service.history(c.id);
  for (const message of page.messages) {
    assert.equal(message.text, "Look at these.");
    assert.deepEqual(
      message.attachments.map((f) => [f.id, f.name, f.type, f.kind]),
      [
        [photo.id, "photo.png", "image/png", "image"],
        [notes.id, "notes.md", "text/plain", "text"],
      ],
    );
  }
  assert.deepEqual(
    page.requests[0].attachments.map((f) => f.id),
    [photo.id, notes.id],
  );
  assert.equal(JSON.stringify(page).includes(workspaces), false);

  // Retrying the same delivery is idempotent and sends nothing twice.
  await service.send(c.id, {
    clientRequestId: "with-files",
    text: "Look at these.",
    attachments: [photo.id, notes.id],
  });
  assert.equal(sent.length, 1);
});

test("files alone are a message, and members only reach their own uploads", async (t) => {
  const { service, sent, agent, workspaces } = setup(t);
  const lead = agent("lead");
  const member = agent("member");
  await assert.rejects(service.send(lead.c.id, { clientRequestId: "empty", text: " " }), {
    status: 400,
  });
  const own = await service.attachments.stage(
    member.c.id,
    "brief.pdf",
    Buffer.from("%PDF-1.7\n"),
  );
  const foreign = await service.attachments.stage(
    lead.c.id,
    "secret.txt",
    Buffer.from("x"),
  );
  await assert.rejects(
    service.send(member.c.id, {
      clientRequestId: "foreign",
      text: "",
      attachments: [foreign.id],
    }),
    { status: 404 },
  );
  await service.send(member.c.id, {
    clientRequestId: "only-files",
    text: "",
    attachments: [own.id],
  });
  const message = sent.at(-1).message;
  assert.match(message, /^\[Files attached by the owner, [^\n]*\]\n- "attachments\//);
  assert.equal(sent.at(-1).attachments, undefined);
  assert.equal(
    fs.readdirSync(path.join(workspaces, member.a.id, "attachments")).length,
    1,
  );
  assert.equal(fs.readdirSync(path.join(workspaces, lead.a.id, "attachments")).length, 1);
  await assert.rejects(
    service.send(lead.c.id, { clientRequestId: "bad", text: "x", attachments: "id" }),
    { status: 400 },
  );
});

test("a retried delivery key cannot add files to an accepted message (M6)", async (t) => {
  const { service, sent, agent } = setup(t);
  const { c } = agent("lead");
  await service.send(c.id, { clientRequestId: "plain", text: "Hello" });
  const late = await service.attachments.stage(c.id, "late.md", Buffer.from("x"));
  await assert.rejects(
    service.send(c.id, {
      clientRequestId: "plain",
      text: "Hello",
      attachments: [late.id],
    }),
    { status: 409 },
  );
  assert.equal(sent.length, 1);
  const page = await service.history(c.id);
  assert.equal(page.requests[0].attachments, undefined);
});
