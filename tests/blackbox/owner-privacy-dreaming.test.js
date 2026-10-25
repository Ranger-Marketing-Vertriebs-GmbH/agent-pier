import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { notFoundBody } from "../../server/http/responses.js";

// Owner decision P1: on a user's own agent, dreaming's notes (memory/dreaming/**) and
// the Dream diary (DREAMS.md) never reach the owner while "Owner may read chats" is
// off. The owner-content guard (owner-content-guard.js) already refuses every memory
// route of her own agent then; these tests pin that for the dreaming files, and what
// he reads once she switches it on.

const dreamNote = "memory/dreaming/light/2026-10-24.md";
const diary = "DREAMS.md";
const ownNote = "memory/trip.md";

async function annaWithDreams(t) {
  const { f, gateway } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: user.id, level: "chat" }] },
    { capabilities: { memory: true, reminders: false } },
  );
  const root = path.join(f.application.assistants.config.workspaces, agent.id);
  for (const [name, content] of [
    [dreamNote, "She said: I fly to Rome on Friday."],
    [diary, "# Dream Diary\n\nRome again."],
    [ownNote, "Trip to Rome"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  // OpenClaw's memory_search finds the dream note and the diary like other notes.
  const call = gateway.client.call;
  gateway.client.call = async (method, params) => {
    if (method === "tools.invoke" && params.name === "memory_search")
      return {
        ok: true,
        output: {
          details: {
            results: [dreamNote, diary, ownNote].map((p) => ({
              path: p,
              snippet: "Rome",
              startLine: 1,
              endLine: 1,
            })),
          },
        },
      };
    if (method === "agents.files.get")
      return { file: { content: "Anna likes Rome.", missing: false } };
    return call(method, params);
  };
  return { f, user, agent, request: as(f, cookie) };
}

const optIn = (f, userId, enabled) =>
  f.request(`/api/users/${userId}/owner-may-read`, { method: "PUT", body: { enabled } });

const memoryRoutes = (id) => [
  `/api/assistants/${id}/memory`,
  `/api/assistants/${id}/memory?name=${diary}`,
  `/api/assistants/${id}/memory?name=${encodeURIComponent(dreamNote)}`,
  `/api/assistants/${id}/memory?name=${encodeURIComponent(ownNote)}`,
  `/api/assistants/${id}/memory/files`,
  `/api/assistants/${id}/memory/search?q=Rome`,
  // Spellings Express routes the same way reach the guard too.
  `/api/assistants/${id}/Memory/Files/`,
  `/api/assistants/${id}/memory/search/?q=Rome`,
];

test("without her opt-in the owner gets no dream note or diary of her own agent", async (t) => {
  const { f, agent, request } = await annaWithDreams(t);
  for (const endpoint of memoryRoutes(agent.id)) {
    for (const method of ["GET", "HEAD"]) {
      const response = await f.request(endpoint, { method });
      assert.equal(response.status, 404, `${method} ${endpoint}`);
      if (method === "GET")
        assert.deepEqual(await response.json(), notFoundBody(), endpoint);
    }
  }
  // His agents list says he may not read it, so his memory view stays closed.
  const list = await (await f.request("/api/assistants")).json();
  assert.equal(list.assistants.find((a) => a.id === agent.id).ownerReads, false);
  // She sees them as usual, the diary first.
  const mine = await (await request(`/api/me/agents/${agent.id}/memory`)).json();
  const names = mine.files.map((file) => file.name);
  assert.equal(names[0], diary);
  assert.deepEqual(names.slice(1).sort(), [dreamNote, ownNote]);
  for (const [name, text] of [
    [diary, /Rome again/],
    [dreamNote, /Friday/],
  ]) {
    const read = await request(
      `/api/me/agents/${agent.id}/memory/${encodeURIComponent(name)}`,
    );
    assert.equal(read.status, 200, name);
    assert.match((await read.json()).content, text);
  }
});

test("switching her opt-in off again closes the dreaming files to the owner", async (t) => {
  const { f, user, agent } = await annaWithDreams(t);
  assert.equal((await optIn(f, user.id, true)).status, 200);
  const files = await f.request(`/api/assistants/${agent.id}/memory/files`);
  assert.equal(files.status, 200);
  assert.equal((await optIn(f, user.id, false)).status, 200);
  for (const endpoint of memoryRoutes(agent.id))
    assert.equal((await f.request(endpoint)).status, 404, endpoint);
});

test("under her opt-in the owner reads her dream notes and diary in full, read-only", async (t) => {
  const { f, user, agent } = await annaWithDreams(t);
  assert.equal((await optIn(f, user.id, true)).status, 200);
  const listed = await (
    await f.request(`/api/assistants/${agent.id}/memory/files`)
  ).json();
  assert.deepEqual(listed.files.map((file) => file.name).sort(), [
    diary,
    dreamNote,
    ownNote,
  ]);
  // The existing rule: memory reads in full, older entries included, so a dream
  // note that quotes her chats from before the opt-in shows too.
  const dream = await f.request(
    `/api/assistants/${agent.id}/memory?name=${encodeURIComponent(dreamNote)}`,
  );
  assert.equal(dream.status, 200);
  assert.match((await dream.json()).content, /Friday/);
  const diaryRead = await f.request(`/api/assistants/${agent.id}/memory?name=${diary}`);
  assert.equal(diaryRead.status, 200);
  assert.equal((await diaryRead.json()).readOnly, true);
  const memory = await (await f.request(`/api/assistants/${agent.id}/memory`)).json();
  assert.equal(memory.content, "Anna likes Rome.");
  const found = await (
    await f.request(`/api/assistants/${agent.id}/memory/search?q=Rome`)
  ).json();
  assert.deepEqual(found.results.map((r) => r.path).sort(), [diary, dreamNote, ownNote]);
  // He only reads: MEMORY.md of her own agent is not his to change.
  const write = await f.request(`/api/assistants/${agent.id}/memory`, {
    method: "PUT",
    body: { name: "MEMORY.md", content: "x", expectedMissing: true },
  });
  assert.equal(write.status, 404);
});
