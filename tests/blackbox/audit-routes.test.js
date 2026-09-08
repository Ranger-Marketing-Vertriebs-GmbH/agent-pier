import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

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
    body: { accountId: "local-shell", name: "Audit fixture", cwd: f.home },
  });
  assert.equal(started.status, 201);
  const session = await started.json();
  const sessions = await (await f.request(`/api/audit?sessionId=${session.id}`)).json();
  assert.equal(sessions.events[0]?.action, "session.started");
  const project = await (
    await f.request("/api/memory/projects", { method: "POST", body: { cwd: f.home } })
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
