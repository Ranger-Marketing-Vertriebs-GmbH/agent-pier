import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applicationFixture } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";
import { fakeGithub, githubIssue } from "../helpers/ticket-fakes.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const run = promisify(execFile);
const copy = serverMessages.tickets;
const SESSION = { tool: "claude", accountId: "a1" };
const body = (keys, extra = {}) => ({
  tickets: keys.map((key) => ({ source: "github", key })),
  kind: "session",
  allowMerge: false,
  session: SESSION,
  ...extra,
});

/**
 * The application with a GitHub-linked project (an origin on github.com, a token
 * profile as the host default) whose ticket reads go to a fake GitHub. The engine never
 * steps here: the owner routes are under test, not the sequence itself.
 */
async function sequenceApp(t) {
  const github = await fakeGithub(t, { issues: [githubIssue(12), githubIssue(13)] });
  const f = await applicationFixture(t, {
    ticketFetch: github.fetchImpl,
    ticketSequences: { intervalMs: 0 },
  });
  t.mock.method(f.application.ticketSequenceEngine, "steps", async () => {});
  await run("git", ["init", "-q", "-b", "main"], { cwd: f.project });
  await run("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], {
    cwd: f.project,
  });
  const project = await f.application.memory.register(f.project);
  const created = await f.request("/api/git-credentials", {
    method: "POST",
    body: { name: "Work", host: "github.com", token: "gh-token" },
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  await f.request(`/api/git-credentials/${id}`, {
    method: "PATCH",
    body: { agentDefault: true },
  });
  const responses = [];
  const call = async (endpoint, options) => {
    const response = await f.request(endpoint, options);
    const text = await response.text();
    responses.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const queue = `/api/tickets/projects/${project.id}/queue`;
  return { f, github, project, call, queue, responses };
}

test("owner adds two tickets and reads the queue", async (t) => {
  const { f, github, project, call, queue } = await sequenceApp(t);
  const signals = [];
  const hub = f.application.live;
  const invalidate = hub.invalidate.bind(hub);
  t.mock.method(hub, "invalidate", (name, param) => {
    signals.push([name, param]);
    return invalidate(name, param);
  });
  const added = await call(queue, {
    method: "POST",
    body: body(["acme/app#12", "ACME/App#13"]),
  });
  assert.equal(added.status, 201);
  const { items } = added.body.queue;
  assert.deepEqual(
    items.map((item) => [item.key, item.title, item.state, item.kind]),
    [
      ["acme/app#12", "Issue 12", "waiting", "session"],
      ["acme/app#13", "Issue 13", "waiting", "session"],
    ],
  );
  assert.deepEqual(items[0].options, { allowMerge: false });
  assert.deepEqual(items[0].origin, { kind: "manual" });
  assert.equal("defaults" in added.body, true);
  assert.deepEqual(
    signals.filter(([name]) => name.startsWith("tickets.")),
    [["tickets.queue", project.id]],
  );
  assert.ok(github.calls.some((entry) => entry.path === "/repos/acme/app/issues/13"));
  const read = await call(queue);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, added.body);
  // The same ticket again while it is queued.
  const again = await call(queue, { method: "POST", body: body(["acme/app#12"]) });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, copy.ticketQueued);
  assert.equal(
    (await call(queue, { method: "POST", body: { tickets: [] } })).status,
    400,
  );
});

test("a restricted user gets 403 on every queue route", async (t) => {
  const { f, call, queue } = await sequenceApp(t);
  const added = await call(queue, { method: "POST", body: body(["acme/app#12"]) });
  const itemId = added.body.queue.items[0].id;
  const { cookie } = await signedInUser(f);
  const headers = { cookie };
  const routes = [
    ["GET", queue],
    ["POST", queue, body(["acme/app#13"])],
    ["POST", `${queue}/${itemId}/retry`],
    ["POST", `${queue}/${itemId}/done`],
    ["DELETE", `${queue}/${itemId}`],
  ];
  for (const [method, endpoint, payload] of routes) {
    const response = await f.request(endpoint, { method, headers, body: payload });
    // Owner routes answer users like unknown routes (route-access.js).
    assert.ok([403, 404].includes(response.status), `${method} ${endpoint}`);
  }
  const [queued] = f.application.ticketSequenceStore.queues();
  assert.deepEqual(
    queued.items.map((item) => [item.id, item.state]),
    [[itemId, "waiting"]],
  );
});

test("retry, done and remove follow the state rules", async (t) => {
  const { f, project, call, queue } = await sequenceApp(t);
  const store = f.application.ticketSequenceStore;
  const added = await call(queue, {
    method: "POST",
    body: body(["acme/app#12", "acme/app#13"]),
  });
  const [first, second] = added.body.queue.items;
  store.patch(project.id, first.id, { state: "running", sessionId: "s1" });
  for (const action of ["retry", "done"]) {
    const refused = await call(`${queue}/${first.id}/${action}`, { method: "POST" });
    assert.equal(refused.status, 409, action);
    assert.equal(refused.body.error, copy.itemBusy);
  }
  // A waiting ticket cannot be retried, but marked done or removed.
  assert.equal(
    (await call(`${queue}/${second.id}/retry`, { method: "POST" })).status,
    409,
  );
  store.patch(project.id, first.id, {
    state: "needs-owner",
    needsOwner: { reason: "sessionEnded", at: 1 },
    rounds: { failed: 3, lastSha: "a", lastReview: null, lastActionAt: 2 },
  });
  const retried = await call(`${queue}/${first.id}/retry`, { method: "POST" });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.queue.items[0].state, "waiting");
  assert.equal(retried.body.queue.items[0].needsOwner, undefined);
  assert.equal(retried.body.queue.items[0].sessionId, undefined);
  assert.equal(retried.body.queue.items[0].rounds.failed, 0);
  const done = await call(`${queue}/${second.id}/done`, { method: "POST" });
  assert.equal(done.status, 200);
  assert.equal(done.body.queue.items[1].state, "done");
  assert.equal(done.body.queue.items[1].doneBy, "owner");
  const removed = await call(`${queue}/${first.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.deepEqual(
    removed.body.queue.items.map((item) => item.id),
    [second.id],
  );
  const missing = await call(`${queue}/${first.id}/done`, { method: "POST" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, copy.itemNotFound);
});

test("remove takes a running item out, never one awaiting its merge", async (t) => {
  const { f, project, call, queue } = await sequenceApp(t);
  const store = f.application.ticketSequenceStore;
  const added = await call(queue, {
    method: "POST",
    body: body(["acme/app#12", "acme/app#13"]),
  });
  const [first, second] = added.body.queue.items;
  store.patch(project.id, first.id, { state: "running", sessionId: "s1" });
  const removed = await call(`${queue}/${first.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.deepEqual(
    removed.body.queue.items.map((item) => item.id),
    [second.id],
  );
  store.patch(project.id, second.id, { state: "running", sessionId: "s2" });
  store.patch(project.id, second.id, {
    state: "awaiting-merge",
    pr: { number: 3, url: "https://github.com/acme/app/pull/3", headRef: "t" },
  });
  const busy = await call(`${queue}/${second.id}`, { method: "DELETE" });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, copy.itemBusy);
});

test("responses never contain the token", async (t) => {
  const { f, project, call, queue, responses } = await sequenceApp(t);
  const added = await call(queue, { method: "POST", body: body(["acme/app#12"]) });
  const store = f.application.ticketSequenceStore;
  store.patch(project.id, added.body.queue.items[0].id, {
    state: "running",
    worktree: { cwd: path.join(f.project, ".worktrees", "x"), branch: "ticket/12" },
  });
  await call(queue);
  await call(`${queue}/${added.body.queue.items[0].id}/retry`, { method: "POST" });
  assert.ok(responses.length >= 3);
  for (const text of responses) {
    assert.doesNotMatch(text, /gh-token|plane-token/);
    assert.equal(text.includes(path.join(f.project, ".worktrees")), false);
  }
});

test("already started tickets need again", async (t) => {
  const { f, project, call, queue } = await sequenceApp(t);
  f.application.ticketStore.addStart({
    projectId: project.id,
    source: "github",
    key: "acme/app#12",
    title: "Issue 12",
    url: "https://github.com/acme/app/issues/12",
    kind: "session",
    targetId: "s-earlier",
    writeBack: { state: "done" },
  });
  const refused = await call(queue, { method: "POST", body: body(["acme/app#12"]) });
  assert.equal(refused.status, 409);
  assert.deepEqual(Object.keys(refused.body).sort(), ["error", "messageKey"].sort());
  assert.equal(refused.body.error, copy.alreadyStarted);
  const again = await call(queue, {
    method: "POST",
    body: body(["acme/app#12"], { again: true }),
  });
  assert.equal(again.status, 201);
  assert.equal(again.body.queue.items.length, 1);
});

test("a sequence without GitHub access is refused with 409", async (t) => {
  const f = await applicationFixture(t, { ticketSequences: { intervalMs: 0 } });
  const folder = path.join(f.project, "plain");
  await fs.mkdir(folder);
  const project = await f.application.memory.register(folder);
  const response = await f.request(`/api/tickets/projects/${project.id}/queue`, {
    method: "POST",
    body: body(["acme/app#12"]),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, copy.githubRequired);
  assert.deepEqual(f.application.ticketSequenceStore.queues(), []);
});
