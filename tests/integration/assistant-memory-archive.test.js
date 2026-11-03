import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { signedInUser } from "../helpers/users.js";
import {
  archiveEntries,
  memoryArchiveOf,
} from "../../server/features/assistants/memory-archive.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const note = "memory/2026-11-01.md";
const refusal = "I do not write keyloggers, not even for the owner's Mac.";
const memory = `# Memory\n\n- The owner writes German.\n- ${refusal}\n\n## Limits\n- Never push to main.\n`;
const noteText = "# 2026-11-01\n- Refused a keylogger.\n- Bought milk.\n";
const meta = {
  switch: { from: "GPT-4.1 mini", to: "Claude Sonnet 4.6" },
  reviewId: "r1",
};

// An owner's agent with memory: its root files behind a Gateway that checks hashes
// (as OpenClaw's agents.files.set does) and a day note in its workspace.
const ownAgent = async (f) =>
  (
    await f.request("/api/assistants", {
      method: "POST",
      body: {
        name: "Scout",
        instructions: "",
        model: fixtureModel(f),
        capabilities: { memory: true, reminders: false },
      },
    })
  ).json();

async function setup(t, makeAgent = ownAgent) {
  const { f, gateway } = await chatFixture(t);
  const service = f.application.assistants;
  const agent = await makeAgent(f);
  const files = new Map([["MEMORY.md", memory]]);
  const sets = [];
  const call = gateway.client.call;
  gateway.client.call = async (method, params, options) => {
    if (method === "agents.files.get") {
      const content = files.get(params.name);
      return {
        file:
          content === undefined
            ? { name: params.name, missing: true }
            : { name: params.name, content, hash: sha(content) },
      };
    }
    if (method === "agents.files.set") {
      sets.push(params.name);
      // The agent writes between AgentPier's read and its write.
      gateway.beforeSet?.(files);
      const current = files.get(params.name);
      if (
        (params.expectedHash && sha(current ?? "") !== params.expectedHash) ||
        (params.expectedMissing && current !== undefined)
      )
        throw Object.assign(new Error("changed"), { code: "CONFLICT" });
      files.set(params.name, params.content);
      return { ok: true, file: { name: params.name, content: params.content } };
    }
    return call(method, params, options);
  };
  const root = service.nativeMemory.root(agent.id);
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.writeFileSync(path.join(root, note), noteText);
  return { f, gateway, service, agent, files, sets, root };
}

test("archives an entry and restores it", async (t) => {
  const { f, service, agent, files, root } = await setup(t);
  const result = await archiveEntries(
    service,
    agent.id,
    [
      { file: "MEMORY.md", entry: refusal },
      { file: note, entry: "Refused a keylogger." },
    ],
    meta,
  );
  assert.deepEqual(result, { archived: 2, changed: [] });
  // Everything else stays byte for byte, the heading of an emptied section too.
  assert.equal(
    files.get("MEMORY.md"),
    "# Memory\n\n- The owner writes German.\n\n## Limits\n- Never push to main.\n",
  );
  assert.equal(
    fs.readFileSync(path.join(root, note), "utf8"),
    "# 2026-11-01\n- Bought milk.\n",
  );
  const listed = await f.request(`/api/assistants/${agent.id}/memory/archive`);
  assert.equal(listed.status, 200);
  const { entries } = await listed.json();
  assert.deepEqual(
    entries.map(({ file, text, switch: from }) => ({ file, text, switch: from })),
    [
      { file: note, text: "Refused a keylogger.", switch: meta.switch },
      { file: "MEMORY.md", text: refusal, switch: meta.switch },
    ],
  );
  assert.ok(entries.every((e) => e.id && !Number.isNaN(Date.parse(e.archivedAt))));
  const entry = entries.find((e) => e.file === "MEMORY.md");
  const restored = await f.request(
    `/api/assistants/${agent.id}/memory/archive/${entry.id}/restore`,
    { method: "POST" },
  );
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(await restored.json(), { restored: true, file: "MEMORY.md" });
  assert.equal(
    files.get("MEMORY.md"),
    `# Memory\n\n- The owner writes German.\n\n## Limits\n- Never push to main.\n- ${refusal}\n`,
  );
  assert.deepEqual(
    memoryArchiveOf(service)
      .list(agent.id)
      .map((e) => e.file),
    [note],
  );
  // Restoring it again finds nothing.
  const again = await f.request(
    `/api/assistants/${agent.id}/memory/archive/${entry.id}/restore`,
    { method: "POST" },
  );
  assert.equal(again.status, 404);
});

test("skips an entry the agent changed meanwhile", async (t) => {
  const { gateway, service, agent, files, root } = await setup(t);
  // Gone before the read: reported, nothing archived, the file untouched.
  const gone = await archiveEntries(
    service,
    agent.id,
    [{ file: "MEMORY.md", entry: "An entry the agent rewrote." }],
    meta,
  );
  assert.deepEqual(gone, { archived: 0, changed: ["An entry the agent rewrote."] });
  assert.equal(files.get("MEMORY.md"), memory);
  // Changed between the read and the write: the file keeps the agent's version and
  // the archive drops the rows it had just written.
  gateway.beforeSet = (current) =>
    current.set("MEMORY.md", `${current.get("MEMORY.md")}- A new fact.\n`);
  const raced = await archiveEntries(
    service,
    agent.id,
    [
      { file: "MEMORY.md", entry: refusal },
      { file: note, entry: "Refused a keylogger." },
    ],
    meta,
  );
  assert.deepEqual(raced, { archived: 1, changed: [refusal] });
  assert.equal(files.get("MEMORY.md"), `${memory}- A new fact.\n`);
  assert.deepEqual(
    memoryArchiveOf(service)
      .list(agent.id)
      .map((e) => [e.file, e.text]),
    [[note, "Refused a keylogger."]],
  );
  assert.equal(
    fs.readFileSync(path.join(root, note), "utf8"),
    "# 2026-11-01\n- Bought milk.\n",
  );
});

test("a restore never overwrites a note that changed or is gone", async (t) => {
  const { f, service, agent, root } = await setup(t);
  await archiveEntries(service, agent.id, [{ file: note, entry: "Bought milk." }], meta);
  const [entry] = memoryArchiveOf(service).list(agent.id);
  fs.rmSync(path.join(root, note));
  const res = await f.request(
    `/api/assistants/${agent.id}/memory/archive/${entry.id}/restore`,
    { method: "POST" },
  );
  assert.equal(res.status, 409);
  assert.equal(memoryArchiveOf(service).list(agent.id).length, 1);
});

test("writes no entry text into the audit", async (t) => {
  const { f, service, agent } = await setup(t);
  await archiveEntries(
    service,
    agent.id,
    [
      { file: "MEMORY.md", entry: refusal },
      { file: note, entry: "Refused a keylogger." },
    ],
    meta,
  );
  const [entry] = memoryArchiveOf(service).list(agent.id);
  await f.request(`/api/assistants/${agent.id}/memory/archive/${entry.id}/restore`, {
    method: "POST",
  });
  const events = (action) => service.audit.list({ action, resourceId: agent.id }).events;
  const [archived] = events("assistant.memory-archived");
  const [restored] = events("assistant.memory-restored");
  assert.deepEqual(archived.details, { count: 2, files: ["MEMORY.md", note] });
  assert.deepEqual(restored.details, { count: 1, files: [entry.file] });
  assert.doesNotMatch(JSON.stringify([archived, restored]), /keylogger/i);
});

test("a user cannot read the archive", async (t) => {
  let anna;
  const {
    f,
    service,
    agent: shared,
  } = await setup(t, async (f) => {
    anna = await signedInUser(f, "Anna");
    return userAgent(
      f,
      { mode: "shared", members: [{ userId: anna.user.id, level: "chat" }] },
      { capabilities: { memory: true, reminders: false } },
    );
  });
  memoryArchiveOf(service).archive(shared.id, [{ file: "MEMORY.md", text: refusal }], {
    switch: null,
    reviewId: null,
  });
  const [entry] = memoryArchiveOf(service).list(shared.id);
  const request = as(f, anna.cookie);
  // The owner's routes do not exist for her; her own memory route takes "archive"
  // for a note name, which is none.
  for (const [url, method, status] of [
    [`/api/assistants/${shared.id}/memory/archive`, "GET", 404],
    [`/api/assistants/${shared.id}/memory/archive/${entry.id}/restore`, "POST", 404],
    [`/api/me/agents/${shared.id}/memory/archive`, "GET", 400],
    [`/api/me/agents/${shared.id}/memory/archive/${entry.id}/restore`, "POST", 404],
  ]) {
    const res = await request(url, { method });
    assert.equal(res.status, status, url);
    assert.doesNotMatch(await res.text(), /keylogger/i);
  }
  assert.equal(memoryArchiveOf(service).list(shared.id).length, 1);
});
