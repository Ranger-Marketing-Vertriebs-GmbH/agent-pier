import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";

async function ownAgent(f, level, released = []) {
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: user.id, level }], released },
    { capabilities: { memory: true, reminders: false } },
  );
  return { user, cookie, agent, request: as(f, cookie) };
}
const settings = async (request, id) =>
  (await request(`/api/me/agents/${id}/settings`)).json();
const patch = (request, id, values, revision) =>
  request(`/api/me/agents/${id}/settings`, {
    method: "PATCH",
    body: { values, revision },
  });

test("chat-only users can read but not change settings", async (t) => {
  const { f } = await chatFixture(t);
  const { agent, request } = await ownAgent(f, "chat");
  const view = await settings(request, agent.id);
  assert.deepEqual(view.fields, []);
  assert.equal(view.values.name, agent.name);
  const response = await patch(request, agent.id, { name: "Nova" }, view.revision);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "USER_LEVEL");
});

test("personalize changes name, avatar and instructions", async (t) => {
  const { f } = await chatFixture(t);
  const { user, agent, request } = await ownAgent(f, "personalize");
  const view = await settings(request, agent.id);
  const response = await patch(
    request,
    agent.id,
    { name: "Nova", avatar: "🦊", instructions: "Secret instructions text" },
    view.revision,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const after = await settings(request, agent.id);
  assert.deepEqual(after.values, {
    name: "Nova",
    avatar: "🦊",
    instructions: "Secret instructions text",
  });
  const stale = await patch(request, agent.id, { name: "Old" }, view.revision);
  assert.equal(stale.status, 409);
  const entries = f.application.audit
    .list({})
    .events.filter((e) => e.resourceId === agent.id && e.actorUserId === user.id);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].details.fields.sort(), ["avatar", "instructions", "name"]);
  assert.doesNotMatch(JSON.stringify(entries), /Secret instructions/);
});

test("extended switches on only released capabilities", async (t) => {
  const { f } = await chatFixture(t);
  const { agent, request } = await ownAgent(f, "extended", ["webSearch"]);
  f.application.assistants.webTools.differs = () => false;
  const view = await settings(request, agent.id);
  assert.deepEqual(view.released, ["webSearch"]);
  const unreleased = await patch(
    request,
    agent.id,
    { capabilities: { browser: true } },
    view.revision,
  );
  assert.equal(unreleased.status, 403);
  const shell = await patch(request, agent.id, { shell: "full" }, view.revision);
  assert.equal(shell.status, 400);
  const on = await patch(
    request,
    agent.id,
    { capabilities: { webSearch: true } },
    view.revision,
  );
  assert.equal(on.status, 200, await on.clone().text());
  assert.equal(
    f.application.assistants.store.getAssistant(agent.id).capabilities.webSearch,
    true,
  );
});

test("shared agents stay owner-managed at every level", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent } = await sharedAgentOfTwo(f, "extended");
  const request = as(f, anna.cookie);
  const view = await settings(request, agent.id);
  assert.deepEqual(view.fields, []);
  assert.equal(view.shared, true);
  const response = await patch(request, agent.id, { name: "Mine" }, view.revision);
  assert.equal(response.status, 403);
  const other = await signedInUser(f, "Carla");
  const refused = await as(f, other.cookie)(`/api/me/agents/${agent.id}/settings`);
  assert.equal(refused.status, 404);
});

test("memory deletion follows level and ownership", async (t) => {
  const { f } = await chatFixture(t);
  const { agent, request } = await ownAgent(f, "personalize");
  const workspaces = f.application.assistants.config.workspaces;
  const note = path.join(workspaces, agent.id, "memory", "trip.md");
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, "Trip to Rome");
  const listed = await (await request(`/api/me/agents/${agent.id}/memory`)).json();
  assert.deepEqual(
    listed.files.map((file) => file.name),
    ["memory/trip.md"],
  );
  const name = encodeURIComponent("memory/trip.md");
  const read = await (await request(`/api/me/agents/${agent.id}/memory/${name}`)).json();
  assert.equal(read.content, "Trip to Rome");
  const removed = await request(`/api/me/agents/${agent.id}/memory/${name}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 204, await removed.clone().text());
  assert.equal(fs.existsSync(note), false);

  const { anna, agent: family } = await sharedAgentOfTwo(f, "extended", [
    "Carla",
    "Dora",
  ]);
  const sharedNote = path.join(workspaces, family.id, "memory", "family.md");
  fs.mkdirSync(path.dirname(sharedNote), { recursive: true });
  fs.writeFileSync(sharedNote, "Family");
  const shared = await as(f, anna.cookie)(
    `/api/me/agents/${family.id}/memory/${encodeURIComponent("memory/family.md")}`,
    { method: "DELETE" },
  );
  assert.equal(shared.status, 403);
  assert.equal((await shared.json()).code, "USER_LEVEL");

  const chat = await signedInUser(f, "Eve");
  const chatAgent = await userAgent(
    f,
    { mode: "own", members: [{ userId: chat.user.id, level: "chat" }] },
    { capabilities: { memory: true, reminders: false } },
  );
  const refused = await as(f, chat.cookie)(
    `/api/me/agents/${chatAgent.id}/memory/${name}`,
    { method: "DELETE" },
  );
  assert.equal(refused.status, 403);
});

test("her memory view pages through notes by offset", async (t) => {
  const { f } = await chatFixture(t);
  const { agent, request } = await ownAgent(f, "personalize");
  const folder = path.join(
    f.application.assistants.config.workspaces,
    agent.id,
    "memory",
  );
  fs.mkdirSync(folder, { recursive: true });
  for (const [name, minute] of [
    ["old.md", 1],
    ["new.md", 2],
  ]) {
    fs.writeFileSync(path.join(folder, name), name);
    const time = new Date(Date.UTC(2026, 9, 1, 0, minute));
    fs.utimesSync(path.join(folder, name), time, time);
  }
  const page = async (query) =>
    (await request(`/api/me/agents/${agent.id}/memory${query}`)).json();
  const first = await page("");
  assert.deepEqual(
    first.files.map((file) => file.name),
    ["memory/new.md", "memory/old.md"],
  );
  assert.equal(first.total, 2);
  assert.equal(first.nextOffset, null);
  assert.deepEqual(
    (await page("?offset=1")).files.map((file) => file.name),
    ["memory/old.md"],
  );
  for (const query of ["?offset=-1", "?offset=x", "?offset=1&offset=2"])
    assert.equal(
      (await request(`/api/me/agents/${agent.id}/memory${query}`)).status,
      400,
      query,
    );
});
