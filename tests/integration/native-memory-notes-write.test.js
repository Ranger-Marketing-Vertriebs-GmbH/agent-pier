import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const note = "memory/2026-10-10.md";

async function setup(t) {
  const { f } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "shared", members: [{ userId: anna.user.id, level: "chat" }] },
    { capabilities: { memory: true, reminders: false } },
  );
  const root = path.join(f.application.assistants.config.workspaces, agent.id);
  for (const [name, content] of [
    [note, "Bought milk"],
    ["memory/lead/plan.md", "Lead plan"],
    ["memory/.dreams/corpus.md", "Raw"],
    ["DREAMS.md", "# Diary"],
    ["MEMORY.md", "Facts"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  const memory = f.application.assistantMemory;
  return { f, agent, root, memory, anna, id: agent.id };
}

test("writes a day note against its hash", async (t) => {
  const { f, id, root, memory } = await setup(t);
  const read = await memory.read(id, note);
  assert.equal(read.editable, true);
  assert.equal(read.hash, sha("Bought milk"));
  const saved = await memory.writeNote(id, {
    name: note,
    content: "Bought milk and tea",
    expectedHash: read.hash,
  });
  assert.deepEqual(saved, { name: note, hash: sha("Bought milk and tea") });
  assert.equal(fs.readFileSync(path.join(root, note), "utf8"), "Bought milk and tea");
  assert.deepEqual(fs.readdirSync(path.join(root, "memory")).sort(), [
    ".dreams",
    "2026-10-10.md",
    "lead",
  ]);
  // Over HTTP as the owner, on the root notes' save path, then the note is deleted.
  const put = await f.request(`/api/assistants/${id}/memory`, {
    method: "PUT",
    body: { name: note, content: "Third", expectedHash: saved.hash },
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).hash, sha("Third"));
  const del = await f.request(
    `/api/assistants/${id}/memory/notes?name=${encodeURIComponent(note)}`,
    { method: "DELETE" },
  );
  assert.equal(del.status, 204);
  assert.equal(fs.existsSync(path.join(root, note)), false);
});

test("refuses a stale hash with conflict", async (t) => {
  const { id, root, memory } = await setup(t);
  await assert.rejects(
    memory.writeNote(id, { name: note, content: "x", expectedHash: sha("old") }),
    { status: 409 },
  );
  assert.equal(fs.readFileSync(path.join(root, note), "utf8"), "Bought milk");
  await assert.rejects(
    memory.writeNote(id, {
      name: "memory/gone.md",
      content: "x",
      expectedHash: sha("old"),
    }),
    { status: 409 },
  );
  assert.equal(fs.existsSync(path.join(root, "memory", "gone.md")), false);
});

test("refuses the lead mirror, the corpus and the diary", async (t) => {
  const { id, root, memory } = await setup(t);
  const expectedHash = sha("Lead plan");
  for (const name of [
    "memory/lead/plan.md",
    "memory/.dreams/corpus.md",
    "DREAMS.md",
    "MEMORY.md",
    "USER.md",
    "memory/../MEMORY.md",
  ])
    await assert.rejects(
      memory.writeNote(id, { name, content: "x", expectedHash }),
      { status: 400 },
      name,
    );
  await assert.rejects(
    memory.writeNote(id, { name: note, content: "x", expectedHash: "nope" }),
    { status: 400 },
  );
  assert.equal(
    fs.readFileSync(path.join(root, "memory/lead/plan.md"), "utf8"),
    "Lead plan",
  );
  assert.equal(fs.readFileSync(path.join(root, "DREAMS.md"), "utf8"), "# Diary");
  assert.equal((await memory.read(id, "memory/lead/plan.md")).editable, undefined);
});

test("keeps a user's own agent read only", async (t) => {
  const { f, id, root, anna } = await setup(t);
  const request = as(f, anna.cookie);
  for (const path of [
    `/api/me/agents/${id}/memory/notes`,
    `/api/me/agents/${id}/memory`,
  ]) {
    const put = await request(path, {
      method: "PUT",
      body: { name: note, content: "x", expectedHash: sha("Bought milk") },
    });
    assert.equal(put.status, 404, path);
  }
  assert.equal(fs.readFileSync(path.join(root, note), "utf8"), "Bought milk");
});

test("owner delete refuses the lead mirror and the corpus", async (t) => {
  const { f, id, root } = await setup(t);
  for (const name of ["memory/lead/plan.md", "memory/.dreams/corpus.md", "DREAMS.md"]) {
    const del = await f.request(
      `/api/assistants/${id}/memory/notes?name=${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    assert.equal(del.status, 400, name);
    assert.equal(fs.existsSync(path.join(root, name)), true, name);
  }
});

test("saves a 100 KiB note and keeps the file mode", async (t) => {
  const { id, root, memory } = await setup(t);
  fs.chmodSync(path.join(root, note), 0o640);
  const big = "x".repeat(100 * 1024);
  const saved = await memory.writeNote(id, {
    name: note,
    content: big,
    expectedHash: sha("Bought milk"),
  });
  assert.equal(saved.hash, sha(big));
  assert.equal(fs.readFileSync(path.join(root, note), "utf8"), big);
  assert.equal(fs.statSync(path.join(root, note)).mode & 0o777, 0o640);
  await assert.rejects(
    memory.writeNote(id, {
      name: note,
      content: "x".repeat(262145),
      expectedHash: saved.hash,
    }),
    { status: 400 },
  );
});

test("refuses a stale hash over HTTP with the conflict code", async (t) => {
  const { f, id, root } = await setup(t);
  const put = await f.request(`/api/assistants/${id}/memory`, {
    method: "PUT",
    body: { name: note, content: "x", expectedHash: sha("old") },
  });
  assert.equal(put.status, 409);
  assert.equal(fs.readFileSync(path.join(root, note), "utf8"), "Bought milk");
});

test("refuses traversal, other folders and links out of the workspace", async (t) => {
  const { f, id, root, memory } = await setup(t);
  const outside = fs.mkdtempSync(path.join(path.dirname(root), "outside-"));
  fs.writeFileSync(path.join(outside, "secret.md"), "Secret");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "memory/link.md"));
  fs.symlinkSync(outside, path.join(root, "memory/linked"));
  const expectedHash = sha("Secret");
  for (const name of [
    "memory/link.md",
    "memory/linked/secret.md",
    "memory/../../outside/secret.md",
    "/etc/passwd",
    "memory/note.txt",
    "notes/2026-10-10.md",
  ]) {
    await assert.rejects(
      memory.write(id, { name, content: "x", expectedHash }),
      { status: 400 },
      name,
    );
    const del = await f.request(
      `/api/assistants/${id}/memory/notes?name=${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    assert.equal(del.status, 400, name);
  }
  assert.equal(fs.readFileSync(path.join(outside, "secret.md"), "utf8"), "Secret");
  // The memory folder itself swapped for a link is refused as well.
  fs.rmSync(path.join(root, "memory"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "memory"));
  await assert.rejects(
    memory.write(id, { name: "memory/secret.md", content: "x", expectedHash }),
    { status: 400 },
  );
  assert.equal(fs.readFileSync(path.join(outside, "secret.md"), "utf8"), "Secret");
});

test("refuses the owner's writes to a user's own agent under her opt-in", async (t) => {
  const { f } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: anna.user.id, level: "personalize" }] },
    { capabilities: { memory: true, reminders: false } },
  );
  const root = path.join(f.application.assistants.config.workspaces, agent.id);
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.writeFileSync(path.join(root, note), "Hers");
  const put = await f.request(`/api/assistants/${agent.id}/memory`, {
    method: "PUT",
    body: { name: note, content: "x", expectedHash: sha("Hers") },
  });
  assert.equal(put.status, 404);
  const del = await f.request(
    `/api/assistants/${agent.id}/memory/notes?name=${encodeURIComponent(note)}`,
    { method: "DELETE" },
  );
  assert.equal(del.status, 404);
  assert.equal(fs.readFileSync(path.join(root, note), "utf8"), "Hers");
});

test("audits a saved and a deleted note by file name only", async (t) => {
  const { f, id } = await setup(t);
  const put = await f.request(`/api/assistants/${id}/memory`, {
    method: "PUT",
    body: {
      name: note,
      content: "Refused a keylogger.",
      expectedHash: sha("Bought milk"),
    },
  });
  assert.equal(put.status, 200);
  const del = await f.request(
    `/api/assistants/${id}/memory/notes?name=${encodeURIComponent(note)}`,
    { method: "DELETE" },
  );
  assert.equal(del.status, 204);
  const audit = f.application.assistants.audit;
  const events = (action) => audit.list({ action, resourceId: id }).events;
  const [saved] = events("assistant.memory-saved");
  const [deleted] = events("assistant.memory-deleted");
  assert.deepEqual(saved.details, { files: [note] });
  assert.deepEqual(deleted.details, { files: [note] });
  assert.doesNotMatch(JSON.stringify([saved, deleted]), /keylogger|milk/i);
});

test("keeps a Hermes agent's workspace notes out of day-note edits", async (t) => {
  const { id, root, memory } = await setup(t);
  const store = memory.assistants.store;
  const getAssistant = store.getAssistant.bind(store);
  t.mock.method(store, "getAssistant", (agentId) => ({
    ...getAssistant(agentId),
    runtime: "hermes",
  }));
  assert.equal((await memory.read(id, note)).editable, undefined);
  await assert.rejects(
    memory.write(id, { name: note, content: "x", expectedHash: sha("Bought milk") }),
    { status: 400 },
  );
  await assert.rejects(memory.remove(id, note, { owner: true }), { status: 400 });
  assert.equal(fs.readFileSync(path.join(root, note), "utf8"), "Bought milk");
});
