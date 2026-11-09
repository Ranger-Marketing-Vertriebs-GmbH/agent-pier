import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AgentAttachments } from "../../server/features/assistants/agent-attachments.js";
import { withAttachments } from "../../server/features/assistants/attachment-history.js";
import { attachmentNote } from "../../server/features/assistants/agent-attachment-types.js";
import {
  UNCLAIMED,
  chatPlaceholderFolders,
  checkedChatFolder,
} from "../../server/features/assistants/chat-file-folders.js";

// A Hermes agent keeps each chat's uploads in that chat's own folder,
// <assistants>/chat-files/<agent>/<chat>/ (chat-file-folders.js), never in its work
// folder, so a search there reaches no chat's files; uploads from before move there
// before its process set starts (chat-file-migration.js).

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const sha = (body) => createHash("sha256").update(body).digest("hex");

function setup(t) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-files-")));
  const workspaces = path.join(dataDir, "workspaces");
  fs.mkdirSync(workspaces, { mode: 0o700 });
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = store.createAssistant({
    name: "Hermes",
    instructions: "",
    model: { connectionId: "endpoint", modelId: "m" },
    runtime: "hermes",
  });
  const chat = (key) =>
    store.saveConversation({ assistantId: agent.id, runtimeSessionKey: key });
  const attachments = new AgentAttachments({
    store,
    models: null,
    config: { workspaces },
  });
  const root = path.join(dataDir, "chat-files", agent.id);
  return { store, attachments, agent, chat, workspaces, root, dataDir };
}
const request = (attachments, conversation, id, ids) => {
  attachments.transaction(() => attachments.claim(conversation.id, ids, id));
  return { id, text: "Look", conversationId: conversation.id };
};

test("a Hermes chat's uploads land in its own chat folder and its note names them", async (t) => {
  const { attachments, agent, chat, workspaces, root } = setup(t);
  const a = chat("a");
  const b = chat("b");
  const stored = await attachments.stage(a.id, "Report.pdf", Buffer.from("%PDF-1.4\n"));
  await attachments.stage(b.id, "photo.png", png);
  const folder = path.join(root, a.id);
  const [file] = fs.readdirSync(folder);
  assert.match(file, /-Report\.pdf$/);
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(folder, file)).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.join(root, b.id)).length, 1);
  // Nothing in the work folder.
  assert.equal(fs.existsSync(path.join(workspaces, agent.id, "attachments")), false);

  const sent = request(attachments, a, "r1", [stored.id]);
  const { message } = await attachments.delivery(sent, agent.id);
  assert.equal(
    message,
    `Look\n\n${attachmentNote(
      [{ path: path.join(folder, file), type: "application/pdf", size: 9 }],
      { folder },
    )}`,
  );
  assert.match(message, /saved in this chat's file folder "/);
  // The chat strips the note it sent, and the one a turn before the move carried.
  const entry = attachments.forConversation(a.id).get("r1");
  for (const text of [
    message,
    `Look\n\n${attachmentNote([{ path: `attachments/${file}`, type: "application/pdf", size: 9 }])}`,
  ]) {
    const [shown] = withAttachments([{ role: "user", text }], [sent], {
      attempts: new Map(),
      byRequest: new Map([["r1", entry]]),
    });
    assert.equal(shown.text, "Look");
    assert.equal(shown.attachments[0].id, stored.id);
  }
  assert.deepEqual(
    (await attachments.content(stored.id)).body,
    Buffer.from("%PDF-1.4\n"),
  );
  assert.equal((await attachments.usage(agent.id)).files, 2);
});

test("a chat folder replaced by a link is refused", async (t) => {
  const { attachments, chat, root, dataDir } = setup(t);
  const a = chat("a");
  const elsewhere = path.join(dataDir, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(elsewhere, path.join(root, a.id));
  await assert.rejects(attachments.stage(a.id, "a.png", png), {
    key: "attachmentStorageUnsafe",
  });
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  await assert.rejects(
    checkedChatFolder(attachments.config, ["x", "../y"], true),
    (error) => error.status === 503,
  );
});

test("clearing and removing chats take their folders", async (t) => {
  const { attachments, agent, chat, root } = setup(t);
  const a = chat("a");
  const b = chat("b");
  const first = await attachments.stage(a.id, "a.png", png);
  await attachments.stage(b.id, "b.png", png);
  request(attachments, a, "r1", [first.id]);
  await attachments.storage.removeChats(agent.id, (id) => id === a.id);
  assert.deepEqual(fs.readdirSync(root), [a.id]);
  await attachments.storage.removeChatFolder(agent.id, a.id);
  assert.deepEqual(fs.readdirSync(root), []);
  await attachments.stage(b.id, "c.png", png);
  const cleared = await attachments.clear(agent.id);
  assert.equal(cleared.files, 1);
  assert.equal(fs.existsSync(root), false);
  // The sent file stays in its message, marked gone.
  assert.equal(attachments.forConversation(a.id).get("r1").files[0].unavailable, true);
});

test("a Hermes agent's attachments/ moves into its chat folders, once", async (t) => {
  const { attachments, agent, chat, workspaces, root } = setup(t);
  const a = chat("a");
  const b = chat("b");
  const old = path.join(workspaces, agent.id, "attachments");
  fs.mkdirSync(old, { recursive: true, mode: 0o700 });
  // Rows as an older AgentPier wrote them: no `chat`, the copy in attachments/.
  const row = (conversation, name, body, requestId = null) => {
    const file = `20260101-000000-0000000${name.length}-${name}`;
    fs.writeFileSync(path.join(old, file), body, { mode: 0o600 });
    const id = `id-${name}`;
    attachments.index(
      id,
      conversation,
      {
        name,
        file,
        size: body.length,
        type: "image/png",
        kind: "image",
        sha256: sha(body),
      },
      requestId,
    );
    return { id, file };
  };
  const sent = row(a, "a.png", png, "r1");
  const staged = row(b, "b.png", png);
  // A run stopped after its rename: the copy already in its chat folder.
  const moved = row(a, "moved.png", png, "r2");
  fs.mkdirSync(path.join(root, a.id), { recursive: true });
  fs.renameSync(path.join(old, moved.file), path.join(root, a.id, moved.file));
  // Copies that are gone in both places.
  const lostSent = row(b, "lost.png", png, "r3");
  const lostStaged = row(b, "lostb.png", png);
  fs.rmSync(path.join(old, lostSent.file));
  fs.rmSync(path.join(old, lostStaged.file));
  // A file no row names.
  fs.writeFileSync(path.join(old, "notes.txt"), "mine");

  assert.equal(await attachments.migrate(agent.id), 3);
  assert.equal(fs.existsSync(old), false);
  assert.deepEqual(
    fs.readdirSync(path.join(root, a.id)).sort(),
    [sent.file, moved.file].sort(),
  );
  assert.deepEqual(fs.readdirSync(path.join(root, b.id)), [staged.file]);
  assert.deepEqual(fs.readdirSync(path.join(root, UNCLAIMED)), ["notes.txt"]);
  const body = (id) =>
    JSON.parse(
      attachments.db.prepare("SELECT body FROM agent_attachments WHERE id=?").get(id)
        ?.body ?? "null",
    );
  assert.equal(body(sent.id).chat, true);
  assert.equal(body(moved.id).chat, true);
  assert.equal(body(lostSent.id).gone, true);
  assert.equal(body(lostStaged.id), null);
  assert.deepEqual((await attachments.content(sent.id)).body, png);
  // Again: nothing left to move.
  assert.equal(await attachments.migrate(agent.id), 0);
  // The unclaimed file counts toward the agent's storage.
  assert.equal((await attachments.usage(agent.id)).files, 4);
  // An older AgentPier after a downgrade marks the sent file gone; it comes back.
  const [stored] = attachments.rows(
    "SELECT * FROM agent_attachments WHERE id=?",
    sent.id,
  );
  attachments.markGone(stored);
  assert.equal(body(sent.id).gone, true);
  await attachments.migrate(agent.id);
  assert.equal(body(sent.id).gone, undefined);
  assert.equal(body(lostSent.id).gone, true);
});

test("an OpenClaw agent keeps attachments/ and is never moved", async (t) => {
  const { attachments, store, workspaces } = setup(t);
  const agent = store.createAssistant({
    name: "OpenClaw",
    instructions: "",
    model: { connectionId: "endpoint", modelId: "m" },
  });
  const c = store.saveConversation({ assistantId: agent.id, runtimeSessionKey: "o" });
  await attachments.stage(c.id, "a.png", png);
  assert.equal(await attachments.migrate(agent.id), 0);
  assert.equal(fs.readdirSync(path.join(workspaces, agent.id, "attachments")).length, 1);
});

test("MCP placeholders name a Hermes agent's chat folders, never on a shared one", () => {
  assert.deepEqual(chatPlaceholderFolders("/d/assistants/workspaces/a1"), {
    "agent.workspace": "/d/assistants/workspaces/a1",
    "agent.attachments": "/d/assistants/chat-files/a1",
  });
  assert.deepEqual(
    chatPlaceholderFolders("/d/assistants/workspaces/a1", { shared: true }),
    {
      "agent.workspace": "/d/assistants/workspaces/a1",
    },
  );
  assert.equal(chatPlaceholderFolders("relative"), null);
});

test("an upload after a move stopped between rename and mark keeps the row", async (t) => {
  const { attachments, agent, chat, root } = setup(t);
  const a = chat("a");
  const file = "20260101-000000-00000000-a.png";
  fs.mkdirSync(path.join(root, a.id), { recursive: true });
  fs.writeFileSync(path.join(root, a.id, file), png, { mode: 0o600 });
  attachments.index(
    "old",
    a,
    {
      name: "a.png",
      file,
      size: png.length,
      type: "image/png",
      kind: "image",
      sha256: sha(png),
    },
    "r1",
  );
  // The quota check of the next upload finds the copy in its chat's folder.
  await attachments.stage(a.id, "b.png", png);
  const body = () =>
    JSON.parse(
      attachments.db.prepare("SELECT body FROM agent_attachments WHERE id='old'").get()
        .body,
    );
  assert.equal(body().gone, undefined);
  await attachments.migrate(agent.id);
  assert.equal(body().chat, true);
  assert.deepEqual((await attachments.content("old")).body, png);
});

test("clearing removes chat folders replaced by a link, never what it points to", async (t) => {
  const { attachments, agent, chat, root, dataDir } = setup(t);
  await attachments.stage(chat("a").id, "a.png", png);
  const elsewhere = path.join(dataDir, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "keep.txt"), "x");
  fs.rmSync(root, { recursive: true });
  fs.symlinkSync(elsewhere, root);
  assert.equal((await attachments.usage(agent.id)).unsafe, true);
  await attachments.clear(agent.id);
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(fs.readdirSync(elsewhere), ["keep.txt"]);
});
