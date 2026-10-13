import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AgentAttachments } from "../../server/features/assistants/agent-attachments.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { MAX_ATTACHMENT_BYTES } from "../../server/features/assistants/agent-attachment-types.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const heic = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypheic"),
  Buffer.alloc(4),
  Buffer.from("mif1heic"),
]);

function setup(t, { images = true, now = () => Date.now() } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attachments-"));
  const workspaces = path.join(dataDir, "workspaces");
  fs.mkdirSync(workspaces, { mode: 0o700 });
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = (name, connectionId = "endpoint") => {
    const a = store.createAssistant({
      name,
      instructions: "",
      model: { connectionId, modelId: "vision" },
    });
    const c = store.saveConversation({ assistantId: a.id, runtimeSessionKey: name });
    return { a, c };
  };
  const connections = {
    get: (id) =>
      id === "router"
        ? { providerId: "openrouter" }
        : {
            providerId: "endpoint",
            endpoint: { models: [{ modelId: "vision", images }] },
          },
  };
  const attachments = new AgentAttachments({
    store,
    models: new AssistantModels({ connections }),
    config: { workspaces },
    now,
  });
  return { store, attachments, agent, workspaces };
}

test("uploads land in the agent's own workspace with private generated names", async (t) => {
  const { attachments, agent, workspaces } = setup(t);
  const lead = agent("lead");
  const member = agent("member");
  const stored = await attachments.stage(lead.c.id, "../../Holiday photo.png", png);
  assert.deepEqual(Object.keys(stored).sort(), ["id", "kind", "name", "size", "type"]);
  assert.equal(stored.name, "Holiday photo.png");
  assert.equal(stored.type, "image/png");
  const folder = path.join(workspaces, lead.a.id, "attachments");
  const [file] = fs.readdirSync(folder);
  assert.match(file, /^\d{8}-\d{6}-[0-9a-f]{8}-Holiday photo\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(folder, file)), png);
  assert.equal(fs.statSync(path.join(folder, file)).mode & 0o777, 0o600);
  // A member's upload stays in the member's workspace.
  await attachments.stage(member.c.id, "notes.md", Buffer.from("# Notes\n"));
  assert.equal(
    fs.readdirSync(path.join(workspaces, member.a.id, "attachments")).length,
    1,
  );
  assert.equal(fs.readdirSync(folder).length, 1);
  // A PDF named like a text file and a JPEG named .txt keep their real type.
  const pdf = await attachments.stage(lead.c.id, "x.txt", Buffer.from("%PDF-1.4\n"));
  assert.equal(pdf.type, "application/pdf");
  assert.ok(fs.readdirSync(folder).some((name) => name.endsWith("x.txt.pdf")));
});

test("uploads are refused when too large, unsupported, too many or unsafe", async (t) => {
  const { attachments, agent, workspaces } = setup(t);
  const { a, c } = agent("lead");
  await assert.rejects(
    attachments.stage(c.id, "big.png", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)),
    {
      status: 413,
      key: "attachmentTooLarge",
    },
  );
  await assert.rejects(attachments.stage(c.id, "tool.exe", Buffer.from("MZ")), {
    status: 415,
    key: "attachmentUnsupported",
  });
  await assert.rejects(attachments.stage(c.id, "a.txt", "text"), { status: 400 });
  await assert.rejects(attachments.stage("missing", "a.txt", Buffer.from("x")), {
    status: 404,
  });
  for (let n = 0; n < 20; n++)
    await attachments.stage(c.id, `n${n}.txt`, Buffer.from("x"));
  await assert.rejects(attachments.stage(c.id, "more.txt", Buffer.from("x")), {
    status: 409,
    key: "attachmentTooMany",
  });
  // A link in place of the folder never redirects a write outside the workspace.
  const other = agent("other");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attachments-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspaces, other.a.id));
  fs.symlinkSync(outside, path.join(workspaces, other.a.id, "attachments"));
  await assert.rejects(attachments.stage(other.c.id, "a.txt", Buffer.from("x")), {
    status: 409,
    key: "attachmentStorageUnsafe",
  });
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.ok(a.id);
});

test("staged uploads expire after a day and can be discarded until sent", async (t) => {
  let clock = Date.parse("2026-10-13T10:00:00Z");
  const { attachments, agent, workspaces } = setup(t, { now: () => clock });
  const { a, c } = agent("lead");
  const old = await attachments.stage(c.id, "old.txt", Buffer.from("old"));
  const kept = await attachments.stage(c.id, "kept.txt", Buffer.from("kept"));
  await attachments.discard(c.id, kept.id);
  assert.equal(fs.readdirSync(path.join(workspaces, a.id, "attachments")).length, 1);
  clock += 25 * 3600 * 1000;
  await attachments.stage(c.id, "new.txt", Buffer.from("new"));
  const files = fs.readdirSync(path.join(workspaces, a.id, "attachments"));
  assert.deepEqual(
    files.map((name) => name.split("-").slice(3).join("-")),
    ["new.txt"],
  );
  await assert.rejects(attachments.discard(c.id, old.id), { status: 404 });
});

test("a request claims its uploads once and delivers images the model can see", async (t) => {
  const { attachments, agent, store } = setup(t);
  const { a, c } = agent("lead");
  const other = agent("other");
  const photo = await attachments.stage(c.id, "photo.png", png);
  const iphone = await attachments.stage(c.id, "IMG_0001.HEIC", heic);
  const notes = await attachments.stage(c.id, "notes.md", Buffer.from("# Notes\n"));
  const foreign = await attachments.stage(other.c.id, "x.txt", Buffer.from("x"));
  const ids = [photo.id, iphone.id, notes.id];
  assert.throws(() => attachments.claim(c.id, [foreign.id], "r0"), { status: 404 });
  assert.throws(() => attachments.claim(c.id, [photo.id, photo.id], "r0"), {
    status: 400,
  });
  assert.throws(
    () =>
      attachments.claim(
        c.id,
        Array.from({ length: 6 }, (_, n) => `x${n}`),
        "r0",
      ),
    {
      status: 400,
      key: "attachmentTooMany",
    },
  );
  assert.deepEqual(
    attachments.claim(c.id, ids, "r1").map((f) => f.id),
    ids,
  );
  // A retried delivery of the same request is idempotent; another set conflicts.
  assert.deepEqual(
    attachments.claim(c.id, ids, "r1").map((f) => f.id),
    ids,
  );
  assert.throws(() => attachments.claim(c.id, [photo.id], "r1"), { status: 409 });
  assert.throws(() => attachments.claim(c.id, [photo.id], "r2"), { status: 404 });
  await assert.rejects(attachments.discard(c.id, photo.id), { status: 404 });
  const delivery = await attachments.delivery({ id: "r1", text: "Look at this." }, a.id);
  const lines = delivery.message.split("\n");
  assert.equal(lines[0], "Look at this.");
  assert.equal(lines[2], "[Attached files, saved in your workspace]");
  assert.match(
    lines[3],
    /^- attachments\/\d{8}-\d{6}-[0-9a-f]{8}-photo\.png \(image\/png, 0\.1 KB\)$/,
  );
  assert.match(lines[4], /IMG_0001\.HEIC \(image\/heic, /);
  assert.match(lines[5], /notes\.md \(text\/plain, /);
  // Only the PNG goes inline: HEIC and text reach the agent as workspace files.
  assert.deepEqual(delivery.attachments, [
    {
      type: "image",
      mimeType: "image/png",
      fileName: "photo.png",
      content: png.toString("base64"),
    },
  ]);
  const history = attachments.forConversation(c.id).get("r1");
  assert.equal(history.note, lines.slice(2).join("\n"));
  assert.deepEqual(
    history.files.map((f) => [f.name, f.kind]),
    [
      ["photo.png", "image"],
      ["IMG_0001.HEIC", "image"],
      ["notes.md", "text"],
    ],
  );
  assert.equal(JSON.stringify(history.files).includes("attachments/"), false);
  // An attachment-only message is just the note.
  const only = await attachments.stage(c.id, "only.txt", Buffer.from("x"));
  attachments.claim(c.id, [only.id], "r3");
  const alone = await attachments.delivery({ id: "r3", text: "" }, a.id);
  assert.match(alone.message, /^\[Attached files, saved in your workspace\]\n- /);
  // A text-only model receives no inline images, only the saved paths.
  const textOnly = agent("text-only", "router");
  assert.equal(attachments.imageInput(textOnly.a.id), false);
  assert.equal(attachments.imageInput(a.id), true);
  const p = await attachments.stage(textOnly.c.id, "p.png", png);
  attachments.claim(textOnly.c.id, [p.id], "r4");
  assert.equal(
    (await attachments.delivery({ id: "r4", text: "Hi" }, textOnly.a.id)).attachments,
    undefined,
  );
  assert.ok(store);
});

test("content is served from the owning workspace only and never through links", async (t) => {
  const { attachments, agent, workspaces } = setup(t);
  const { a, c } = agent("lead");
  const photo = await attachments.stage(c.id, "photo.png", png);
  assert.deepEqual(await attachments.content(photo.id), {
    name: "photo.png",
    type: "image/png",
    kind: "image",
    body: png,
  });
  await assert.rejects(attachments.content("missing"), { status: 404 });
  const folder = path.join(workspaces, a.id, "attachments");
  const [file] = fs.readdirSync(folder);
  fs.rmSync(path.join(folder, file));
  fs.symlinkSync("/etc/hosts", path.join(folder, file));
  await assert.rejects(attachments.content(photo.id), { status: 404 });
  // Purging removes the folder and the index.
  await attachments.purge(a.id);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(attachments.forConversation(c.id).size, 0);
});
