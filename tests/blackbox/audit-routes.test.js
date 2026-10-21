import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";

test("real API mutations create bounded audit events, reads do not and history survives restart", async (t) => {
  const f = await applicationFixture(t);
  let response = await f.request("/api/audit");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 0);
  response = await f.request("/api/accounts", {
    method: "POST",
    body: { name: "Audit fixture", tool: "codex", apiKey: "fixture-audit-secret" },
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  response = await f.request("/api/audit?action=account.created");
  const first = await response.json();
  assert.equal(first.total, 1);
  assert.equal(first.events[0].resourceId, created.id);
  assert.equal(JSON.stringify(first).includes("fixture-audit-secret"), false);
  assert.equal(first.events[0].outcome, "success");
  response = await f.request("/api/accounts", {
    method: "POST",
    body: { name: "", tool: "codex", apiKey: "fixture-audit-secret" },
  });
  assert.equal(response.status, 400);
  await f.restart();
  response = await f.request("/api/audit");
  const after = await response.json();
  assert.equal(after.total, 2);
  assert.equal(after.events[0].outcome, "failure");
  assert.equal((await (await f.request("/api/audit")).json()).total, 2);
});
test("invalid operation submission is audited without including secret options", async (t) => {
  const f = await applicationFixture(t);
  const response = await f.request("/api/operations/backups", {
    method: "POST",
    body: { unexpected: "private-test-passphrase" },
  });
  assert.equal(response.status, 400);
  const audit = await (await f.request("/api/audit")).json();
  assert.equal(audit.events[0]?.action, "backup.started");
  assert.equal(audit.events[0].outcome, "failure");
  assert.equal(JSON.stringify(audit).includes("private-test-passphrase"), false);
});
test("session and project audit filters include their creation and failed mutations", async (t) => {
  const f = await applicationFixture(t);
  const started = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-shell", name: "Audit fixture", cwd: f.project },
  });
  assert.equal(started.status, 201);
  const session = await started.json();
  const sessions = await (await f.request(`/api/audit?sessionId=${session.id}`)).json();
  assert.equal(sessions.events[0]?.action, "session.started");
  const project = await (
    await f.request("/api/memory/projects", { method: "POST", body: { cwd: f.project } })
  ).json();
  const response = await f.request(`/api/memory/projects/${project.id}/entries`, {
    method: "POST",
    body: { title: "", content: "invalid" },
  });
  assert.equal(response.status, 400);
  const events = await (await f.request(`/api/audit?projectId=${project.id}`)).json();
  assert.equal(events.total, 2);
  assert.equal(events.events[0].action, "memory.created");
  assert.equal(events.events[0].outcome, "failure");
  assert.equal(events.events[0].resourceId, undefined);
});

test("a user's settings change shows her name", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna", "Anna K");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "personalize" }],
  });
  const request = as(f, cookie);
  const view = await (await request(`/api/me/agents/${agent.id}/settings`)).json();
  const changed = await request(`/api/me/agents/${agent.id}/settings`, {
    method: "PATCH",
    body: { values: { name: "Nova" }, revision: view.revision },
  });
  assert.equal(changed.status, 200, await changed.clone().text());
  // The owner's own change carries no user.
  await f.request(`/api/users/${user.id}`, {
    method: "PATCH",
    body: { displayName: "Anna K" },
  });
  const { events } = await (await f.request("/api/audit")).json();
  const hers = events.find((event) => event.actorUserId === user.id);
  assert.equal(hers.resourceId, agent.id);
  assert.equal(hers.actorName, "Anna K");
  const owners = events.find((event) => event.resourceType === "user");
  assert.equal(owners.actorUserId, undefined);
  assert.equal(owners.actorName, undefined);
  // Users never read the audit log.
  assert.equal((await request("/api/audit")).status, 404);
  // After her deletion the entry still says a user acted, without a name.
  f.application.users.remove(user.id);
  const later = (await (await f.request("/api/audit")).json()).events.find(
    (event) => event.actorUserId === user.id,
  );
  assert.equal(later.actorName, null);
});

test("no chat text appears in audit details", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "personalize" }],
  });
  const request = as(f, cookie);
  const opened = await request(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const { id } = await opened.json();
  const sent = await request(`/api/me/conversations/${id}/messages`, {
    method: "POST",
    body: { clientRequestId: "first", text: "My private chat secret" },
  });
  assert.equal(sent.status, 202, await sent.clone().text());
  const all = await (await f.request("/api/audit?pageSize=100")).json();
  assert.doesNotMatch(JSON.stringify(all), /private chat secret/);
});
