import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AgentAttachments } from "../../server/features/assistants/agent-attachments.js";
import { UNCLAIMED } from "../../server/features/assistants/chat-file-folders.js";

// Images an older AgentPier kept in a Hermes agent's generated-images/ leave the work
// folder of an agent shared with users before its next start
// (hermes-image-migration.js): into the chat whose shared file holds their bytes, or
// to .unclaimed.

const png = (n) =>
  Buffer.concat([
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
    Buffer.from(`image ${n}`),
  ]);

function setup(t, mode = "shared") {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "old-images-")));
  const workspaces = path.join(dataDir, "workspaces");
  fs.mkdirSync(workspaces, { mode: 0o700 });
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const created = store.createAssistant({
    name: "Hermes",
    instructions: "",
    model: { connectionId: "endpoint", modelId: "m" },
    runtime: "hermes",
  });
  if (mode) {
    const members = [{ userId: "anna", level: "chat" }];
    if (mode === "shared") members.push({ userId: "ben", level: "chat" });
    store.db.prepare("UPDATE assistants SET body=? WHERE id=?").run(
      JSON.stringify({
        ...store.storedAssistant(created.id),
        userAccess: { mode, members, released: [] },
      }),
      created.id,
    );
  }
  const agent = store.getAssistant(created.id);
  const chat = (key) =>
    store.saveConversation({ assistantId: agent.id, runtimeSessionKey: key });
  const attachments = new AgentAttachments({
    store,
    models: null,
    config: { workspaces },
  });
  const old = path.join(workspaces, agent.id, "generated-images");
  fs.mkdirSync(old, { recursive: true });
  const root = path.join(dataDir, "chat-files", agent.id);
  return { attachments, agent, chat, old, root, dataDir };
}
// An image the older plugin copied into generated-images/ and shared into `chat`.
async function created(f, chat, name, body) {
  fs.writeFileSync(path.join(f.old, name), body);
  if (chat)
    await f.attachments.shared.share({
      conversation: chat,
      requestId: `r-${name}`,
      name,
      body,
    });
}

test("a shared Hermes agent's old images move into their chats or .unclaimed, once", async (t) => {
  const f = setup(t);
  const anna = f.chat("anna");
  const ben = f.chat("ben");
  await created(f, anna, "image_1.png", png(1));
  await created(f, ben, "image_2.png", png(2));
  await created(f, null, "image_3.png", png(3));
  // Bytes changed since the share: nobody's chat gets them.
  await created(f, anna, "image_4.png", png(4));
  fs.writeFileSync(path.join(f.old, "image_4.png"), png(5));
  const elsewhere = path.join(f.dataDir, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "keep.png"), png(6));
  fs.symlinkSync(path.join(elsewhere, "keep.png"), path.join(f.old, "link.png"));
  fs.mkdirSync(path.join(f.old, "nested"));

  assert.equal(await f.attachments.migrate(f.agent.id), 6);
  assert.equal(fs.existsSync(f.old), false);
  assert.deepEqual(fs.readdirSync(path.join(f.root, anna.id)), ["generated-image_1.png"]);
  assert.deepEqual(fs.readdirSync(path.join(f.root, ben.id)), ["generated-image_2.png"]);
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, ben.id, "generated-image_2.png")),
    png(2),
  );
  assert.deepEqual(fs.readdirSync(path.join(f.root, UNCLAIMED)).sort(), [
    "image_3.png",
    "image_4.png",
    "link.png",
    "nested",
  ]);
  // The link moved itself, never what it points to.
  assert.ok(fs.lstatSync(path.join(f.root, UNCLAIMED, "link.png")).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(elsewhere), ["keep.png"]);
  // The quota counts them now, and a second start finds nothing to move.
  assert.equal((await f.attachments.usage(f.agent.id)).files, 6);
  assert.equal(await f.attachments.migrate(f.agent.id), 0);
});

test("a start after a stopped move finishes it and never overwrites a chat's image", async (t) => {
  const f = setup(t);
  const anna = f.chat("anna");
  await created(f, anna, "image_1.png", png(1));
  await created(f, anna, "image_2.png", png(2));
  // The stopped run moved image_1 already; a copy of the same name holds image_2's
  // place.
  fs.mkdirSync(path.join(f.root, anna.id), { recursive: true });
  fs.renameSync(
    path.join(f.old, "image_1.png"),
    path.join(f.root, anna.id, "generated-image_1.png"),
  );
  fs.writeFileSync(path.join(f.root, anna.id, "generated-image_2.png"), png(7));
  assert.equal(await f.attachments.migrate(f.agent.id), 1);
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, anna.id, "generated-image_2.png")),
    png(7),
  );
  assert.deepEqual(fs.readdirSync(path.join(f.root, UNCLAIMED)), ["image_2.png"]);
  assert.equal(fs.existsSync(f.old), false);
});

for (const mode of ["own", null])
  test(`${mode ? "a user's own" : "the owner's"} Hermes agent keeps its generated-images/`, async (t) => {
    const f = setup(t, mode);
    await created(f, f.chat("anna"), "image_1.png", png(1));
    assert.equal(await f.attachments.migrate(f.agent.id), 0);
    assert.deepEqual(fs.readdirSync(f.old), ["image_1.png"]);
  });

test("a generated-images link in the work folder is left alone", async (t) => {
  const f = setup(t);
  const elsewhere = path.join(f.dataDir, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "keep.png"), png(1));
  fs.rmSync(f.old, { recursive: true });
  fs.symlinkSync(elsewhere, f.old);
  assert.equal(await f.attachments.migrate(f.agent.id), 0);
  assert.deepEqual(fs.readdirSync(elsewhere), ["keep.png"]);
  assert.ok(fs.lstatSync(f.old).isSymbolicLink());
});
