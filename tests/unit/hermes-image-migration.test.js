import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AgentAttachments } from "../../server/features/assistants/agent-attachments.js";
import { UNCLAIMED } from "../../server/features/assistants/chat-file-folders.js";
import { leftoverImages } from "../../server/features/assistants/hermes-image-migration.js";

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

// Names as Hermes gives a created image (agent/provider_media.py).
const n = (i) => `image_20261101_12000${i}_0000000${i}.png`;

test("a shared Hermes agent's old images move into their chats or .unclaimed, once", async (t) => {
  const f = setup(t);
  const anna = f.chat("anna");
  const ben = f.chat("ben");
  const gone = f.chat("gone");
  await created(f, anna, n(1), png(1));
  await created(f, ben, n(2), png(2));
  await created(f, null, n(3), png(3));
  // Bytes changed since the share: nobody's chat gets them.
  await created(f, anna, n(4), png(4));
  fs.writeFileSync(path.join(f.old, n(4)), png(5));
  // Its chat was removed since: .unclaimed.
  await created(f, gone, n(5), png(6));
  const db = f.attachments.store.db;
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("DELETE FROM conversations WHERE id=?").run(gone.id);
  db.exec("PRAGMA foreign_keys = ON");
  // A link named as an image moves itself, never what it points to.
  const elsewhere = path.join(f.dataDir, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "keep.png"), png(7));
  fs.symlinkSync(path.join(elsewhere, "keep.png"), path.join(f.old, n(6)));
  // Files named otherwise are the agent's or a user's own: they stay.
  fs.writeFileSync(path.join(f.old, "logo.png"), png(8));
  fs.mkdirSync(path.join(f.old, "nested"));

  assert.equal(await f.attachments.migrate(f.agent.id), 6);
  assert.deepEqual(fs.readdirSync(f.old).sort(), ["logo.png", "nested"]);
  assert.deepEqual(fs.readdirSync(path.join(f.root, anna.id)), [`generated-${n(1)}`]);
  assert.deepEqual(fs.readdirSync(path.join(f.root, ben.id)), [`generated-${n(2)}`]);
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, ben.id, `generated-${n(2)}`)),
    png(2),
  );
  assert.equal(fs.existsSync(path.join(f.root, gone.id)), false);
  assert.deepEqual(fs.readdirSync(path.join(f.root, UNCLAIMED)).sort(), [
    n(3),
    n(4),
    n(5),
    n(6),
  ]);
  assert.ok(fs.lstatSync(path.join(f.root, UNCLAIMED, n(6))).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(elsewhere), ["keep.png"]);
  assert.equal(leftoverImages(f.old), false);
  // The quota counts them now, and a second start moves nothing.
  assert.equal((await f.attachments.usage(f.agent.id)).files, 6);
  assert.equal(await f.attachments.migrate(f.agent.id), 0);
  assert.deepEqual(fs.readdirSync(f.old).sort(), ["logo.png", "nested"]);
});

test("a start after a stopped move finishes it and never overwrites a chat's image", async (t) => {
  const f = setup(t);
  const anna = f.chat("anna");
  await created(f, anna, n(1), png(1));
  await created(f, anna, n(2), png(2));
  // The stopped run moved the first already; a copy of the same name holds the
  // second's place.
  fs.mkdirSync(path.join(f.root, anna.id), { recursive: true });
  fs.renameSync(path.join(f.old, n(1)), path.join(f.root, anna.id, `generated-${n(1)}`));
  fs.writeFileSync(path.join(f.root, anna.id, `generated-${n(2)}`), png(7));
  assert.equal(await f.attachments.migrate(f.agent.id), 1);
  assert.deepEqual(
    fs.readFileSync(path.join(f.root, anna.id, `generated-${n(2)}`)),
    png(7),
  );
  assert.deepEqual(fs.readdirSync(path.join(f.root, UNCLAIMED)), [n(2)]);
  assert.equal(fs.existsSync(f.old), false);
});

test("an image that cannot move stays, and the other moves go on", async (t) => {
  const f = setup(t);
  const anna = f.chat("anna");
  await created(f, anna, n(1), png(1));
  await created(f, null, n(2), png(2));
  // .unclaimed is a link: nothing may go there.
  fs.mkdirSync(f.root, { recursive: true });
  fs.symlinkSync(f.dataDir, path.join(f.root, UNCLAIMED));
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(await f.attachments.migrate(f.agent.id), 1);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(fs.readdirSync(f.old), [n(2)]);
  assert.equal(leftoverImages(f.old), true);
  assert.deepEqual(fs.readdirSync(path.join(f.root, anna.id)), [`generated-${n(1)}`]);
});

for (const mode of ["own", null])
  test(`${mode ? "a user's own" : "the owner's"} Hermes agent keeps its generated-images/`, async (t) => {
    const f = setup(t, mode);
    await created(f, f.chat("anna"), n(1), png(1));
    assert.equal(await f.attachments.migrate(f.agent.id), 0);
    assert.deepEqual(fs.readdirSync(f.old), [n(1)]);
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
