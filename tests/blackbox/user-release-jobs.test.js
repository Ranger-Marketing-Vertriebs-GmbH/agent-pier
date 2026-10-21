import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import {
  deleteReleasedSessions,
  retireReleased,
} from "../../server/features/users/user-release.js";

const heartbeat = { enabled: true, interval: "4h", start: 8, end: 20, timeZone: "UTC" };

// Anna's own agent with her check-in job and one reminder, both native jobs.
async function annasJobs(f) {
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: user.id, level: "extended" }] },
    { capabilities: { memory: true, reminders: true } },
  );
  const assistants = f.application.assistants;
  const record = assistants.store.getAssistant(agent.id);
  assistants.store.updateAssistant(agent.id, { heartbeat }, record.revision);
  await assistants.admit(() => assistants.reminders.heartbeats.sync(agent.id));
  const created = await as(f, cookie)(`/api/me/agents/${agent.id}/reminders`, {
    method: "POST",
    body: {
      clientRequestId: "dentist-request",
      name: "dentist",
      message: "Remember the dentist",
      schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  return { user, cookie, agent };
}

// Anna's chat with a delivered reminder result, whose text lives only in AgentPier.
async function deliveredReminder(f, { cookie, agent }) {
  const opened = await as(f, cookie)(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const { id } = await opened.json();
  const results = f.application.assistants.reminders.results;
  results.record({
    id: "run-1",
    conversationId: id,
    name: "dentist",
    text: "Dentist at 8",
  });
  return { id, results };
}

for (const optIn of [false, true])
  test(`deleting a user ${optIn ? "keeps" : "forgets"} her reminder texts and results (opt-in ${optIn})`, async (t) => {
    const { f } = await chatFixture(t);
    const anna = await annasJobs(f);
    const { id, results } = await deliveredReminder(f, anna);
    if (optIn)
      await f.request(`/api/users/${anna.user.id}/owner-may-read`, {
        method: "PUT",
        body: { enabled: true },
      });
    const removed = await f.request(`/api/users/${anna.user.id}`, {
      method: "DELETE",
      // Keeping her own agent needs her opt-in.
      body: { agents: optIn ? "keep" : "archive" },
    });
    assert.equal(removed.status, 204, await removed.clone().text());
    assert.equal(results.forConversation(id).length, optIn ? 1 : 0);
    const bindings = f.application.assistants.reminders.bindings.list(anna.agent.id);
    const reminder = bindings.find((b) => b.kind !== "heartbeat");
    assert.equal(reminder.definition?.name ?? null, optIn ? "dentist" : null);
    const stored = JSON.stringify(
      f.application.assistants.store.db
        .prepare("SELECT body FROM assistant_reminder_bindings")
        .all(),
    );
    assert.equal(stored.includes("Remember the dentist"), optIn);
  });

const states = (f, agentId) =>
  f.application.assistants.reminders.bindings.list(agentId).map((b) => b.state);

test("deleting a user removes her check-in and reminder jobs", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, agent } = await annasJobs(f);
  const jobs = [...gateway.jobs.values()];
  assert.equal(jobs.length, 2);
  assert.ok(jobs.some((j) => j.name === "AgentPier check-in"));
  const removed = await f.request(`/api/users/${user.id}`, {
    method: "DELETE",
    body: { agents: "archive" },
  });
  assert.equal(removed.status, 204);
  assert.deepEqual([...gateway.jobs.values()], []);
  assert.deepEqual(states(f, agent.id), ["removed", "removed"]);
});

test("jobs a deleted user left while the Gateway was away go at its next start", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, agent } = await annasJobs(f);
  gateway.client.ready = false;
  const removed = await f.request(`/api/users/${user.id}`, {
    method: "DELETE",
    body: { agents: "archive" },
  });
  assert.equal(removed.status, 204);
  // Revoked at once, so a late run delivers nothing.
  assert.deepEqual(states(f, agent.id), ["revoked", "revoked"]);
  assert.equal(gateway.jobs.size, 2);
  gateway.client.ready = true;
  await retireReleased({ assistants: f.application.assistants });
  assert.deepEqual([...gateway.jobs.values()], []);
  assert.deepEqual(states(f, agent.id), ["removed", "removed"]);
});

test("a routine she creates while her deletion runs ends with her", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const ben = await signedInUser(f, "Ben");
  const agent = await userAgent(
    f,
    {
      mode: "shared",
      members: [anna, ben].map((u) => ({ userId: u.user.id, level: "personalize" })),
    },
    { capabilities: { memory: false, reminders: true } },
  );
  const assistants = f.application.assistants;
  const routines = assistants.reminders.routines;
  const routine = (userId, name) =>
    routines.create(
      agent.id,
      {
        clientRequestId: `${name}-request`,
        name,
        prompt: `Check ${name}`,
        trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      },
      null,
      undefined,
      { userId },
    );
  await assistants.admit(() => assistants.reminders.openMain(agent.id, ben.user.id));
  const bens = await routine(ben.user.id, "bens");
  await routine(anna.user.id, "first");
  // Her next routine reaches admission while her first job is being removed.
  const call = gateway.client.call;
  let late;
  gateway.client.call = (method, params) => {
    if (method === "cron.remove" && !late) late = routine(anna.user.id, "late");
    return call(method, params);
  };
  const removed = await f.request(`/api/users/${anna.user.id}`, {
    method: "DELETE",
    body: { agents: "archive" },
  });
  assert.equal(removed.status, 204, await removed.clone().text());
  const created = await late;
  assert.equal(assistants.reminders.bindings.get(created.id).state, "removed");
  assert.deepEqual(
    [...gateway.jobs.values()].map((j) => j.name),
    ["bens"],
  );
  // A binding of hers the release missed never stops the others from syncing.
  const bindings = assistants.reminders.bindings;
  const target = bindings.get(bens.id).target;
  bindings.patch(created.id, { state: "bound" });
  bindings.patch(bens.id, { target: { ...target, sessionKey: "stale" } });
  await assistants.admit(() => routines.sync(agent.id));
  assert.deepEqual(bindings.get(bens.id).target, target);
});

test("her transcript left while the Gateway was away goes at its next start", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "chat" }],
  });
  const opened = await as(f, cookie)(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const { id } = await opened.json();
  const assistants = f.application.assistants;
  const key = assistants.store.getConversation(id).runtimeSessionKey;
  const deleted = () =>
    gateway.calls.filter((c) => c.method === "sessions.delete" && c.params.key === key);
  gateway.client.ready = false;
  const removed = await f.request(`/api/users/${user.id}`, {
    method: "DELETE",
    body: { agents: "archive" },
  });
  assert.equal(removed.status, 204);
  assert.deepEqual(deleted(), []);
  gateway.client.ready = true;
  await deleteReleasedSessions({ assistants });
  assert.equal(deleted().length, 1);
  assert.equal(assistants.store.getConversation(id).nativeDeletePending, false);
  // Deleted once: a later start leaves it alone.
  await deleteReleasedSessions({ assistants });
  assert.equal(deleted().length, 1);
});

test("a disabled user's check-ins stay off when her agent syncs again", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, agent } = await annasJobs(f);
  const disabled = await f.request(`/api/users/${user.id}`, {
    method: "PATCH",
    body: { disabled: true },
  });
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.deepEqual([...gateway.jobs.values()], []);
  // A Gateway start or a settings save converges her check-ins again.
  const assistants = f.application.assistants;
  await assistants.admit(() => assistants.reminders.heartbeats.sync(agent.id));
  assert.deepEqual([...gateway.jobs.values()], []);
  assert.deepEqual(states(f, agent.id), ["removed", "removed"]);
});

test("a user disabled while agents are off loses her jobs once agents start", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, agent } = await annasJobs(f);
  const feature = (enabled) =>
    f.request("/api/assistant-feature", { method: "PUT", body: { enabled } });
  assert.equal((await feature(false)).status, 200);
  assert.equal(f.application.assistants, null);
  const disabled = await f.request(`/api/users/${user.id}`, {
    method: "PATCH",
    body: { disabled: true },
  });
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.equal((await feature(true)).status, 200);
  // Revoked before anything runs; the native jobs go at the Gateway's start.
  assert.deepEqual(states(f, agent.id), ["revoked", "revoked"]);
  const assistants = f.application.assistants;
  gateway.client.ready = true;
  assistants.runtime.client = gateway.client;
  await retireReleased({ assistants });
  assert.deepEqual([...gateway.jobs.values()], []);
  assert.deepEqual(states(f, agent.id), ["removed", "removed"]);
});
