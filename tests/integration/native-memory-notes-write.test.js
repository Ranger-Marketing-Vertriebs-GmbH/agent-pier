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
  // Over HTTP as the owner, then the note can be deleted.
  const put = await f.request(`/api/assistants/${id}/memory/notes`, {
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
  const put = await request(`/api/me/agents/${id}/memory/notes`, {
    method: "PUT",
    body: { name: note, content: "x", expectedHash: sha("Bought milk") },
  });
  assert.equal(put.status, 404);
  assert.equal(fs.readFileSync(path.join(root, note), "utf8"), "Bought milk");
});
