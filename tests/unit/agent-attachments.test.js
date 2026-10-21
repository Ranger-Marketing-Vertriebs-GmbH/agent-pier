import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AgentAttachments } from "../../server/features/assistants/agent-attachments.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { withAttachments } from "../../server/features/assistants/attachment-history.js";
import {
  MAX_ATTACHMENT_BYTES,
  NOTE_HEADER,
  USER_NOTE_HEADER,
} from "../../server/features/assistants/agent-attachment-types.js";

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

function setup(t, { images = true, now = () => Date.now(), hooks } = {}) {
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
    hooks,
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

test("uploads are refused when too large, unsupported or unsafe", async (t) => {
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

test("uploads abandoned by closed pages make room for a new message", async (t) => {
  let clock = Date.parse("2026-10-13T10:00:00Z");
  const { attachments, agent, workspaces } = setup(t, { now: () => clock++ });
  const { a, c } = agent("lead");
  const folder = path.join(workspaces, a.id, "attachments");
  const sent = await attachments.stage(c.id, "sent.md", Buffer.from("s"));
  attachments.claim(c.id, [sent.id], "r1");
  // Four reloads, each leaving the five files a message may hold.
  const abandoned = [];
  for (let n = 0; n < 20; n++)
    abandoned.push(await attachments.stage(c.id, `n${n}.txt`, Buffer.from("x")));
  // A fresh page's first file is accepted; the oldest unsent upload makes room.
  const fresh = await attachments.stage(c.id, "fresh.txt", Buffer.from("y"));
  await assert.rejects(attachments.discard(c.id, abandoned[0].id), { status: 404 });
  await attachments.discard(c.id, abandoned[1].id);
  await attachments.discard(c.id, fresh.id);
  // Sent files are never reclaimed.
  assert.equal(attachments.files("r1").length, 1);
  assert.equal(fs.readdirSync(folder).length, 19);
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
  assert.equal(lines[2], NOTE_HEADER);
  assert.match(
    lines[3],
    /^- "attachments\/\d{8}-\d{6}-[0-9a-f]{8}-photo\.png" \(image\/png, 0\.1 KB\)$/,
  );
  assert.match(lines[4], /IMG_0001\.HEIC" \(image\/heic, /);
  assert.match(lines[5], /notes\.md" \(text\/plain, /);
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
  assert.ok(alone.message.startsWith(`${NOTE_HEADER}\n- "attachments/`));
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
    inline: true,
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

test("a folder swapped for a link during the write receives nothing (M1)", async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attachments-swap-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  let swap = false;
  const { attachments, agent } = setup(t, {
    hooks: {
      checked: (folder) => {
        if (!swap) return;
        fs.renameSync(folder.path, `${folder.path}-moved`);
        fs.symlinkSync(outside, folder.path);
      },
    },
  });
  const { c } = agent("lead");
  swap = true;
  await assert.rejects(attachments.stage(c.id, "evil.md", Buffer.from("owner data")), {
    status: 409,
    key: "attachmentStorageUnsafe",
  });
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(attachments.forConversation(c.id).size, 0);
});

test("reads refuse hard links, swapped and grown copies (M1, M2)", async (t) => {
  const { attachments, agent, workspaces } = setup(t);
  const { a, c } = agent("lead");
  const folder = path.join(workspaces, a.id, "attachments");
  const fileOf = (name) => fs.readdirSync(folder).find((f) => f.endsWith(name));
  const linked = await attachments.stage(c.id, "linked.png", png);
  fs.linkSync(
    path.join(folder, fileOf("linked.png")),
    path.join(workspaces, "elsewhere.png"),
  );
  await assert.rejects(attachments.content(linked.id), { status: 404 });
  const swapped = await attachments.stage(c.id, "swapped.png", png);
  const target = path.join(folder, fileOf("swapped.png"));
  // Replaced by other bytes of the same size: Linux may even reuse the inode number.
  fs.rmSync(target);
  fs.writeFileSync(target, Buffer.alloc(png.length, 0x42));
  await assert.rejects(attachments.content(swapped.id), { status: 404 });
  const grown = await attachments.stage(c.id, "grown.png", png);
  fs.appendFileSync(path.join(folder, fileOf("grown.png")), Buffer.alloc(7 * 1048576));
  await assert.rejects(attachments.content(grown.id), { status: 404 });
  // Nothing of these goes inline, whatever the index once recorded.
  attachments.claim(c.id, [linked.id, swapped.id, grown.id], "r");
  const turn = await attachments.delivery({ id: "r", text: "x" }, a.id);
  assert.equal(turn.attachments, undefined);
  const fine = await attachments.stage(c.id, "fine.png", png);
  assert.deepEqual((await attachments.content(fine.id)).body, png);
  // A copy restored with its bytes at a new inode (as a backup restore does) is kept.
  const restored = path.join(folder, fileOf("fine.png"));
  fs.rmSync(restored);
  fs.writeFileSync(restored, png);
  assert.deepEqual((await attachments.content(fine.id)).body, png);
});

test("stored names stay within 255 UTF-8 bytes (M4)", async (t) => {
  const { attachments, agent, workspaces } = setup(t);
  const { a, c } = agent("lead");
  const stored = await attachments.stage(
    c.id,
    `${"写".repeat(300)}.txt`,
    Buffer.from("x"),
  );
  assert.ok(Buffer.byteLength(stored.name) <= 200);
  const [file] = fs.readdirSync(path.join(workspaces, a.id, "attachments"));
  assert.ok(Buffer.byteLength(file) <= 255, `${Buffer.byteLength(file)} bytes`);
  const forced = await attachments.stage(c.id, `${"写".repeat(300)}`, png);
  assert.ok(forced.name.length > 0);
  for (const name of fs.readdirSync(path.join(workspaces, a.id, "attachments")))
    assert.ok(Buffer.byteLength(name) <= 255);
});

test("the index follows the folder and a failed insert leaves no file (M5)", async (t) => {
  const { attachments, agent, workspaces } = setup(t);
  const { a, c } = agent("lead");
  const folder = path.join(workspaces, a.id, "attachments");
  const sent = await attachments.stage(c.id, "sent.md", Buffer.from("x"));
  attachments.claim(c.id, [sent.id], "r1");
  const note = attachments.forConversation(c.id).get("r1").note;
  // The agent deletes its copy: the next upload marks the sent file gone. Its row stays,
  // so the history still recognises the note the agent received, and the message
  // names the file as unavailable.
  fs.rmSync(path.join(folder, fs.readdirSync(folder)[0]));
  await attachments.stage(c.id, "next.md", Buffer.from("y"));
  assert.deepEqual(attachments.forConversation(c.id).get("r1"), {
    files: [{ ...sent, unavailable: true }],
    note,
  });
  // A staged upload whose copy is gone loses its row.
  const staged = await attachments.stage(c.id, "staged.md", Buffer.from("w"));
  fs.rmSync(
    path.join(
      folder,
      fs.readdirSync(folder).find((f) => f.endsWith("staged.md")),
    ),
  );
  await attachments.stage(c.id, "after.md", Buffer.from("v"));
  await assert.rejects(attachments.discard(c.id, staged.id), { status: 404 });
  // Files the agent put there itself count against the quota as well.
  for (let n = 0; n < 1000; n++) fs.writeFileSync(path.join(folder, `junk-${n}`), "");
  await assert.rejects(attachments.stage(c.id, "full.md", Buffer.from("z")), {
    status: 409,
    key: "attachmentStorageFull",
  });
  for (let n = 0; n < 1000; n++) fs.rmSync(path.join(folder, `junk-${n}`));
  const before = fs.readdirSync(folder).length;
  attachments.index = () => {
    throw Error("database is locked");
  };
  await assert.rejects(attachments.stage(c.id, "lost.md", Buffer.from("z")));
  assert.equal(fs.readdirSync(folder).length, before);
});

test("the history hides the note after the agent removed one of the copies", async (t) => {
  const { attachments, agent, workspaces } = setup(t);
  const { a, c } = agent("lead");
  const one = await attachments.stage(c.id, "one.md", Buffer.from("1"));
  const two = await attachments.stage(c.id, "two.md", Buffer.from("2"));
  attachments.claim(c.id, [one.id, two.id], "r1");
  const request = { id: "r1", text: "Read these." };
  const sent = (await attachments.delivery(request, a.id)).message;
  const view = (message) =>
    withAttachments([{ id: "m1", role: "user", ...message }], [request], {
      attempts: new Map([["key-1", "r1"]]),
      byRequest: attachments.forConversation(c.id),
    })[0];
  assert.equal(view({ text: sent }).text, "Read these.");
  // The agent tidies its workspace; the owner attaches the next file.
  const folder = path.join(workspaces, a.id, "attachments");
  fs.rmSync(
    path.join(
      folder,
      fs.readdirSync(folder).find((f) => f.endsWith("one.md")),
    ),
  );
  await attachments.stage(c.id, "next.md", Buffer.from("3"));
  for (const message of [{ text: sent }, { text: sent, turnKey: "key-1" }]) {
    const shown = view(message);
    assert.equal(shown.text, "Read these.");
    assert.deepEqual(
      shown.attachments.map((f) => [f.name, f.unavailable === true]),
      [
        ["one.md", true],
        ["two.md", false],
      ],
    );
  }
});

test("a user's files are announced as hers and her older turns still strip", async (t) => {
  const { attachments, agent } = setup(t);
  const { a, c } = agent("lead");
  const stored = attachments.store.storedConversation.bind(attachments.store);
  attachments.store.storedConversation = (id) =>
    id === c.id ? { ...stored(id), userId: "u-1" } : stored(id);
  const one = await attachments.stage(c.id, "one.md", Buffer.from("1"));
  attachments.claim(c.id, [one.id], "r1");
  const request = { id: "r1", text: "Read this." };
  const sent = (await attachments.delivery(request, a.id, { byUser: true })).message;
  assert.ok(sent.includes(USER_NOTE_HEADER));
  assert.ok(!sent.includes(NOTE_HEADER));
  // A turn she sent before her files were named hers carried the owner's header.
  const before = (await attachments.delivery(request, a.id)).message;
  for (const text of [sent, before]) {
    const [shown] = withAttachments([{ id: "m1", role: "user", text }], [request], {
      attempts: new Map(),
      byRequest: attachments.forConversation(c.id),
    });
    assert.equal(shown.text, "Read this.");
    assert.deepEqual(
      shown.attachments.map((f) => f.name),
      ["one.md"],
    );
  }
});

test("an accepted request cannot gain files on a retry (M6)", async (t) => {
  const { attachments, agent } = setup(t);
  const { c } = agent("lead");
  const late = await attachments.stage(c.id, "late.md", Buffer.from("x"));
  assert.deepEqual(attachments.claim(c.id, [], "accepted", true), []);
  assert.throws(() => attachments.claim(c.id, [late.id], "accepted", true), {
    status: 409,
  });
  assert.equal(attachments.files("accepted").length, 0);
});

test("a copy linked out of a swapped folder is never written (R1)", async (t) => {
  let outside, folder, moved;
  const { attachments, agent, workspaces, store } = setup(t, {
    hooks: {
      // Between the open and the check, the real folder comes back and the file
      // created outside is linked into it, so path and inode match again.
      checked: () => {
        if (!moved) return;
        const [name] = fs.readdirSync(outside);
        fs.unlinkSync(folder);
        fs.renameSync(moved, folder);
        fs.linkSync(path.join(outside, name), path.join(folder, name));
      },
    },
  });
  const { a, c } = agent("lead");
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attachments-link-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  await attachments.stage(c.id, "warm.md", Buffer.from("w"));
  folder = path.join(workspaces, a.id, "attachments");
  const create = attachments.create.bind(attachments);
  attachments.create = async (...args) => {
    moved = `${folder}-moved`;
    fs.renameSync(folder, moved);
    fs.symlinkSync(outside, folder);
    return create(...args);
  };
  await assert.rejects(attachments.stage(c.id, "e.fish", Buffer.from("echo pwned")), {
    status: 409,
    key: "attachmentStorageUnsafe",
  });
  for (const name of fs.readdirSync(outside))
    assert.equal(fs.readFileSync(path.join(outside, name), "utf8"), "");
  assert.equal(fs.readdirSync(folder).filter((n) => n.endsWith("e.fish")).length, 0);
  assert.ok(store);
});

test("an image rewritten in place is neither shown nor sent inline (R2)", async (t) => {
  const { attachments, agent, workspaces } = setup(t);
  const { a, c } = agent("lead");
  const photo = await attachments.stage(c.id, "p.png", png);
  const folder = path.join(workspaces, a.id, "attachments");
  const [name] = fs.readdirSync(folder);
  const fd = fs.openSync(path.join(folder, name), "r+");
  fs.writeSync(fd, Buffer.alloc(png.length, 0x41), 0, png.length, 0);
  fs.closeSync(fd);
  await assert.rejects(attachments.content(photo.id), { status: 404 });
  // Nor does it travel inline to the model.
  attachments.claim(c.id, [photo.id], "r");
  assert.equal(
    (await attachments.delivery({ id: "r", text: "x" }, a.id)).attachments,
    undefined,
  );
});
