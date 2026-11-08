import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { craftRebuildsRoutes } from "../../server/http/routes/craft-rebuilds.js";
import { registerResponses } from "../../server/http/responses.js";
import { craftStacks } from "../../server/features/craft/craft-stacks.js";
import {
  craftRebuildTopic,
  craftRebuildsChanged,
  craftRebuildsTopic,
} from "../../server/features/craft/live-topics.js";
import { createCraftRebuilds } from "../../server/application/craft-rebuilds-wiring.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { rebuildsFixture, until } from "../helpers/craft-rebuilds-fixture.js";

const question = { ask: "question", title: "Which colour?", choices: ["Red", "Blue"] };

/** The real rebuild routes over `services`. */
async function app(t, services) {
  const application = express();
  application.use(express.json());
  application.use("/api", craftRebuildsRoutes(services));
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  return async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      body: text ? JSON.parse(text) : null,
    };
  };
}

const servicesOf = (f) => ({ craftRebuilds: f.rebuilds, craft: f.rebuilds.craft });
const owner = { role: "owner" };

test("GET /craft/rebuilds lists rebuilds, defaults, eligible accounts and stacks", async (t) => {
  const f = rebuildsFixture(t);
  const request = await app(t, servicesOf(f));
  const empty = await request("GET", "/api/craft/rebuilds");
  assert.equal(empty.status, 200);
  assert.equal(empty.cache, "no-store");
  assert.deepEqual(empty.body, {
    rebuilds: [],
    settings: { accountId: "local-claude", mode: "clean-room", autoMode: false },
    accounts: [
      { id: "local-claude", name: "Local" },
      { id: "acc-a", name: "A" },
      { id: "acc-b", name: "B" },
    ],
    stacks: [...craftStacks],
    installed: true,
  });
  const started = await request("POST", "/api/craft/rebuilds", {
    request: "A counter app",
    accountId: "acc-a",
    stack: "Python",
  });
  assert.equal(started.status, 201);
  assert.equal(started.body.status, "building");
  assert.equal(started.body.accountId, "acc-a");
  assert.equal(started.body.source, "owner");
  const listed = await request("GET", "/api/craft/rebuilds");
  assert.deepEqual(
    listed.body.rebuilds.map((item) => item.id),
    [started.body.id],
  );
  // The topic carries exactly the route's body.
  assert.deepEqual(await craftRebuildsTopic(servicesOf(f)).read(owner), listed.body);
  const one = await request("GET", `/api/craft/rebuilds/${started.body.id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body, { rebuild: f.rebuilds.get(started.body.id) });
  assert.deepEqual(
    await craftRebuildTopic(servicesOf(f)).read(owner, started.body.id),
    one.body,
  );
});

test("unknown rebuilds answer 404 over REST and null on the topic", async (t) => {
  const f = rebuildsFixture(t);
  const request = await app(t, servicesOf(f));
  const id = "0000aaaa-0000-4000-8000-000000000000";
  const missing = await request("GET", `/api/craft/rebuilds/${id}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, serverMessages.craft.rebuildNotFound);
  assert.equal(missing.body.messageKey, "craft.rebuildNotFound");
  for (const path of ["pause", "continue"]) {
    const answer = await request("POST", `/api/craft/rebuilds/${id}/${path}`);
    assert.equal(answer.status, 404, path);
  }
  assert.deepEqual(await craftRebuildTopic(servicesOf(f)).read(owner, id), {
    rebuild: null,
  });
});

test("refusals pass through: validation 400, conflicts 409", async (t) => {
  const f = rebuildsFixture(t);
  const request = await app(t, servicesOf(f));
  const stack = await request("POST", "/api/craft/rebuilds", {
    request: "x",
    stack: "COBOL",
  });
  assert.equal(stack.status, 400);
  assert.equal(stack.body.messageKey, "craft.rebuildStackInvalid");
  const empty = await request("POST", "/api/craft/rebuilds", { request: " " });
  assert.equal(empty.status, 409);
  const provider = await request("POST", "/api/craft/rebuilds", {
    request: "x",
    accountId: "acc-provider",
  });
  assert.equal(provider.status, 409);
  assert.equal(provider.body.messageKey, "craft.rebuildAccountIneligible");
  const settings = await request("PUT", "/api/craft/settings", { mode: "nope" });
  assert.equal(settings.status, 400);
  assert.deepEqual(f.rebuilds.list(), []);
});

test("PUT /craft/settings saves the owner's defaults", async (t) => {
  const f = rebuildsFixture(t);
  const request = await app(t, servicesOf(f));
  const saved = await request("PUT", "/api/craft/settings", {
    accountId: "acc-b",
    mode: "deep",
    autoMode: true,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { accountId: "acc-b", mode: "deep", autoMode: true });
  const listed = await request("GET", "/api/craft/rebuilds");
  assert.deepEqual(listed.body.settings, saved.body);
});

test("a rebuild is paused, continued, followed up, answered and read over REST", async (t) => {
  const f = rebuildsFixture(t, { script: { steps: [question, { wait: 10000 }] } });
  const request = await app(t, servicesOf(f));
  const { body: view } = await request("POST", "/api/craft/rebuilds", {
    request: "Answer me",
  });
  const base = `/api/craft/rebuilds/${view.id}`;
  assert.ok(await until(() => f.rebuilds.get(view.id).status === "needs_you"));
  const [open] = f.rebuilds.get(view.id).questions;
  const invalid = await request("POST", `${base}/answer`, { questionId: open.id });
  assert.equal(invalid.status, 400);
  const answered = await request("POST", `${base}/answer`, {
    questionId: open.id,
    choice: "Blue",
  });
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.body.questions, []);
  const twice = await request("POST", `${base}/answer`, {
    questionId: open.id,
    choice: "Red",
  });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.messageKey, "craft.rebuildQuestionGone");
  const activity = await request("GET", `${base}/activity?limit=50`);
  assert.equal(activity.status, 200);
  assert.ok(activity.body.lines.some((line) => line.includes("Answered q1: Blue")));
  const unbounded = await request("GET", `${base}/activity?limit=x`);
  assert.equal(unbounded.status, 200);
  const auto = await request("POST", `${base}/auto-mode`, { on: true });
  assert.equal(auto.status, 200);
  assert.equal(auto.body.autoMode, true);
  const badAuto = await request("POST", `${base}/auto-mode`, { on: "yes" });
  assert.equal(badAuto.status, 400);
  const running = await request("POST", `${base}/follow-up`, { request: "Blue" });
  assert.equal(running.status, 409);
  assert.equal(running.body.messageKey, "craft.rebuildRunning");
  const paused = await request("POST", `${base}/pause`);
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, "paused");
  const followed = await request("POST", `${base}/follow-up`, { request: "Blue" });
  assert.equal(followed.status, 200);
  assert.ok(
    f.craftRecord(view).conversation.some((entry) => entry.text === "Blue"),
    "the follow-up reached Craft Anything",
  );
  await request("POST", `${base}/pause`);
  const resumed = await request("POST", `${base}/continue`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, "building");
});

test("without the supervisor every route answers 503", async (t) => {
  const request = await app(t, {});
  for (const [method, url] of [
    ["GET", "/api/craft/rebuilds"],
    ["POST", "/api/craft/rebuilds"],
    ["PUT", "/api/craft/settings"],
    ["GET", "/api/craft/rebuilds/0000aaaa-0000-4000-8000-000000000000"],
    ["POST", "/api/craft/rebuilds/0000aaaa-0000-4000-8000-000000000000/pause"],
  ]) {
    const answer = await request(method, url);
    assert.equal(answer.status, 503, `${method} ${url}`);
    assert.equal(answer.cache, "no-store");
  }
  assert.throws(() => craftRebuildsTopic({}).read(owner), {
    status: 503,
    expected: true,
  });
});

test("supervisor changes signal the list and the rebuild topics", async (t) => {
  const f = rebuildsFixture(t);
  const signals = [];
  const hub = { invalidate: (...args) => signals.push(args) };
  const services = {
    config: { dataDir: f.dataDir },
    craft: f.rebuilds.craft,
    accounts: f.rebuilds.accounts,
    preferences: f.rebuilds.preferences,
    memory: f.rebuilds.memory,
    live: hub,
  };
  assert.equal(createCraftRebuilds({ ...services, craft: null }), null);
  const rebuilds = createCraftRebuilds(services);
  t.after(() => rebuilds.close());
  await rebuilds.saveSettings({ mode: "deep" });
  assert.deepEqual(signals, [["craft.rebuilds"], ["craft.rebuild"]]);
  signals.length = 0;
  craftRebuildsChanged(hub, { id: "r1" });
  craftRebuildsChanged(hub);
  craftRebuildsChanged(null, { id: "r1" });
  assert.deepEqual(signals, [
    ["craft.rebuilds"],
    ["craft.rebuild", "r1"],
    ["craft.rebuilds"],
  ]);
});
