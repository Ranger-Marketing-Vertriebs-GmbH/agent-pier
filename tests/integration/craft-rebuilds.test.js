import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rebuildsConfigDir } from "../../server/features/tools/craft-config.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { ownerQuestions } from "../../server/features/craft/rebuild-questions.js";
import { AUTO_ALLOW_TRIES } from "../../server/features/craft/rebuild-sampler.js";
import {
  exists,
  fakeTimers,
  rebuildsFixture,
  until,
} from "../helpers/craft-rebuilds-fixture.js";

const question = { ask: "question", title: "Which colour?", choices: ["Red", "Blue"] };
const approval = { ask: "approval", title: "Run npm install?", action: "npm install" };

const settled = (rebuilds, id, status, timeoutMs) =>
  until(() => rebuilds.get(id)?.status === status, timeoutMs);

test("start creates and registers a project, inits git and writes .gitignore", async (t) => {
  const f = rebuildsFixture(t);
  const changes = [];
  f.rebuilds.onChange((event) => changes.push(event));
  const view = await f.rebuilds.start({ request: "A counter app" }, { source: "owner" });
  assert.equal(view.folder, path.join(f.projectsDir, "A counter app"));
  assert.equal(view.name, "A counter app");
  assert.equal(view.projectId, f.projects[0].id);
  assert.equal(f.projects[0].cwd, view.folder);
  assert.ok(fs.existsSync(path.join(view.folder, ".git")));
  assert.equal(
    fs.readFileSync(path.join(view.folder, ".gitignore"), "utf8"),
    "capture/\nchecks/\ninbox/\ninvestigation.cany/\n",
  );
  assert.ok(fs.existsSync(path.join(view.folder, "craft.json")), "Craft writes into it");
  assert.equal(view.status, "building");
  assert.equal(view.step, "build");
  assert.equal(view.source, "owner");
  assert.deepEqual(
    f.rebuilds.list().map((item) => item.id),
    [view.id],
  );
  assert.ok(changes.some((event) => event.list));
  // A second rebuild of the same request gets a folder of its own.
  const second = await f.rebuilds.start({ request: "A counter app" });
  assert.equal(second.folder, path.join(f.projectsDir, "A counter app 2"));
  const saved = JSON.parse(
    fs.readFileSync(path.join(f.dataDir, "craft-rebuilds", "rebuilds.json"), "utf8"),
  );
  assert.equal(saved.rebuilds.length, 2);
  assert.equal(
    fs.statSync(path.join(f.dataDir, "craft-rebuilds", "rebuilds.json")).mode & 0o777,
    0o600,
  );
});

test("start passes project_folder, build_with and rounds", async (t) => {
  const f = rebuildsFixture(t);
  const view = await f.rebuilds.start({
    request: "A notes app",
    target: "https://example.com/notes",
    stack: "Plain HTML and CSS",
    rounds: 3,
  });
  const record = f.craftRecord(view);
  assert.equal(record.request, "A notes app");
  assert.equal(record.target, "https://example.com/notes");
  assert.equal(record.stack, "Plain HTML and CSS");
  assert.equal(record.rounds, 3);
  assert.equal(record.questions_mode, "ask");
  assert.equal(view.stack, "Plain HTML and CSS");
  assert.equal(view.rounds, 3);
  const plain = await f.rebuilds.start({ request: "Another" });
  assert.equal(f.craftRecord(plain).stack, "Builder's choice");
  assert.equal(f.craftRecord(plain).target, "-");
  await assert.rejects(f.rebuilds.start({ request: "x", stack: "COBOL" }), {
    status: 400,
  });
  await assert.rejects(f.rebuilds.start({ request: "x", target: "relative/path" }), {
    status: 400,
  });
  await assert.rejects(f.rebuilds.start({ request: "  " }), { status: 400 });
});

test("each account gets its own child with its own CLAUDE_CONFIG_DIR", async (t) => {
  const f = rebuildsFixture(t);
  const a = await f.rebuilds.start({ request: "App A", accountId: "acc-a" });
  const b = await f.rebuilds.start({ request: "App B", accountId: "acc-b" });
  const a2 = await f.rebuilds.start({ request: "App A2", accountId: "acc-a" });
  assert.equal(f.clients.length, 2, "one child per account");
  assert.equal(f.craftRecord(a).fake_builder.claude_config_dir, f.profile("acc-a"));
  assert.equal(f.craftRecord(b).fake_builder.claude_config_dir, f.profile("acc-b"));
  assert.equal(f.craftRecord(a2).fake_builder.claude_config_dir, f.profile("acc-a"));
  for (const spawned of f.spawned) {
    assert.deepEqual(spawned.args, ["mcp", "--all-tools", "--allow-run", "--clean-room"]);
    assert.equal(spawned.env.CRAFT_ANYTHING_CONFIG_DIR, rebuildsConfigDir(f.dataDir));
    assert.equal(spawned.env.CRAFT_ANYTHING_NO_KEYCHAIN, "1");
    assert.match(spawned.command, /craft-anything-cli$/);
  }
  assert.ok(fs.existsSync(path.join(rebuildsConfigDir(f.dataDir), "config.toml")));
  await assert.rejects(f.rebuilds.start({ request: "x", accountId: "acc-provider" }), {
    status: 409,
  });
});

test("deep mode uses its own child", async (t) => {
  const f = rebuildsFixture(t);
  await f.rebuilds.start({ request: "Clean", accountId: "acc-a" });
  const deep = await f.rebuilds.start({
    request: "Deep",
    accountId: "acc-a",
    mode: "deep",
  });
  assert.equal(deep.mode, "deep");
  assert.equal(f.clients.length, 2);
  assert.equal(f.spawned[1].args.at(-1), "--deep");
});

test("a non-owner source cannot choose account, mode or auto mode", async (t) => {
  const f = rebuildsFixture(t);
  await f.rebuilds.saveSettings({
    accountId: "acc-b",
    mode: "clean-room",
    autoMode: false,
  });
  const input = {
    request: "From a session",
    stack: "Python",
    accountId: "acc-a",
    mode: "deep",
    autoMode: true,
    rounds: 5,
    requestId: "retry-1",
  };
  const view = await f.rebuilds.start(input, { source: "session" });
  assert.equal(view.accountId, "acc-b");
  assert.equal(view.mode, "clean-room");
  assert.equal(view.autoMode, false);
  assert.equal(view.stack, "Python");
  assert.equal(view.source, "session");
  assert.equal(f.craftRecord(view).rounds, null);
  assert.equal(f.craftRecord(view).questions_mode, "ask");
  // A retry with the same request id returns the same rebuild.
  const retry = await f.rebuilds.start(input, { source: "session" });
  assert.equal(retry.id, view.id);
  assert.equal(f.rebuilds.list().length, 1);
  assert.equal(f.projects.length, 1);
});

test("auto mode off asks, on decides and allows approvals", async (t) => {
  const f = rebuildsFixture(t, {
    // The first step waits: a question asked before project_questions_set would
    // still reach the owner.
    script: {
      steps: [{ wait: 300 }, question, approval, { finish: "ready", reply: "Done" }],
    },
  });
  const asking = await f.rebuilds.start({ request: "Asking", autoMode: false });
  assert.ok(await settled(f.rebuilds, asking.id, "needs_you"));
  const open = f.rebuilds.get(asking.id).questions;
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, "question");
  assert.deepEqual(open[0].choices, ["Red", "Blue"]);

  const deciding = await f.rebuilds.start({ request: "Deciding", autoMode: true });
  assert.ok(await settled(f.rebuilds, deciding.id, "ready"));
  const record = f.craftRecord(deciding);
  assert.equal(record.questions_mode, "decide");
  const texts = record.conversation.map((entry) => entry.text);
  assert.ok(texts.some((text) => text.startsWith("Decided: Which colour?")));
  assert.ok(texts.includes("Run npm install?: allowed"));
  assert.equal(f.rebuilds.get(deciding.id).lastReply, "Done");
  assert.equal(f.rebuilds.get(deciding.id).step, "ready");

  // Switching auto mode on lets the waiting approval through.
  await f.rebuilds.answer(asking.id, open[0].id, { choice: "Red" });
  assert.ok(
    await until(() => f.rebuilds.get(asking.id).questions[0]?.kind === "approval"),
  );
  await f.rebuilds.setAutoMode(asking.id, true);
  assert.ok(await settled(f.rebuilds, asking.id, "ready"));
  assert.equal(f.craftRecord(asking).questions_mode, "decide");
});

test("answer forwards to project_inbox_answer", async (t) => {
  const f = rebuildsFixture(t, { script: { steps: [question, { wait: 10000 }] } });
  const view = await f.rebuilds.start({ request: "Answer me" });
  assert.ok(await settled(f.rebuilds, view.id, "needs_you"));
  const [open] = f.rebuilds.get(view.id).questions;
  const answered = await f.rebuilds.answer(view.id, open.id, { choice: "Blue" });
  assert.deepEqual(answered.questions, []);
  assert.equal(answered.status, "building");
  const texts = f.craftRecord(view).conversation.map((entry) => entry.text);
  assert.ok(texts.includes("Which colour?: Blue"));
  await assert.rejects(f.rebuilds.answer(view.id, open.id, { choice: "Red" }), {
    status: 409,
  });
  await assert.rejects(f.rebuilds.answer(view.id, open.id, {}), { status: 400 });
  await assert.rejects(f.rebuilds.answer("missing", "q1", { choice: "x" }), {
    status: 404,
  });
  const { lines } = await f.rebuilds.activity(view.id, { limit: 50 });
  assert.ok(lines.some((line) => line.includes("Answered q1: Blue")));
});

test("a question answered twice is refused as already answered", async (t) => {
  let answers = 0;
  const f = rebuildsFixture(t, {
    script: { steps: [question, { wait: 10000 }] },
    intercept: (name) => {
      if (name === "project_inbox_answer") answers++;
    },
  });
  const view = await f.rebuilds.start({ request: "Answer me twice" });
  assert.ok(await settled(f.rebuilds, view.id, "needs_you"));
  const [open] = f.rebuilds.get(view.id).questions;
  // The inbox and the Rebuilds page answer at the same time.
  const results = await Promise.allSettled([
    f.rebuilds.answer(view.id, open.id, { choice: "Red" }),
    f.rebuilds.answer(view.id, open.id, { choice: "Blue" }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.status, 409);
  assert.equal(results[1].reason.message, serverMessages.craft.rebuildQuestionGone);
  assert.equal(answers, 1, "Craft Anything is asked once");
  const texts = f.craftRecord(view).conversation.map((entry) => entry.text);
  assert.deepEqual(
    texts.filter((text) => text.startsWith("Which colour?")),
    ["Which colour?: Red"],
  );
});

test("pause stops the build and continue resumes it", async (t) => {
  const f = rebuildsFixture(t);
  const view = await f.rebuilds.start({ request: "Pause me" });
  const builder = f.craftRecord(view).fake_builder.pid;
  assert.equal(exists(builder), true);
  const paused = await f.rebuilds.pause(view.id);
  assert.equal(paused.status, "paused");
  assert.ok(await until(() => !exists(builder)));
  const resumed = await f.rebuilds.continue(view.id);
  assert.equal(resumed.status, "building");
  const again = f.craftRecord(view).fake_builder.pid;
  assert.notEqual(again, builder);
  assert.equal(exists(again), true);
  await assert.rejects(f.rebuilds.continue(view.id), { status: 409 });
});

test("followUp sends a request to the same project", async (t) => {
  const f = rebuildsFixture(t, { script: { steps: [{ finish: "ready" }] } });
  const view = await f.rebuilds.start({ request: "First" });
  assert.ok(await settled(f.rebuilds, view.id, "ready"));
  await assert.rejects(f.rebuilds.followUp(view.id, " "), { status: 400 });
  await f.rebuilds.followUp(view.id, "Make it blue");
  const record = f.craftRecord(view);
  assert.ok(record.conversation.some((entry) => entry.text === "Make it blue"));
  assert.ok(await settled(f.rebuilds, view.id, "ready"));
  assert.equal(f.rebuilds.list().length, 1);
  assert.equal(f.clients.length, 1);
});

test("shutdown leaves no builder process", async (t) => {
  const f = rebuildsFixture(t);
  const one = await f.rebuilds.start({ request: "One", accountId: "acc-a" });
  const two = await f.rebuilds.start({ request: "Two", accountId: "acc-b" });
  const builders = [f.craftRecord(one), f.craftRecord(two)].map(
    (r) => r.fake_builder.pid,
  );
  const children = f.clients.map((client) => client.pid);
  assert.ok(builders.every(exists));
  await f.rebuilds.close();
  assert.ok(await until(() => [...builders, ...children].every((pid) => !exists(pid))));
  assert.equal(f.rebuilds.get(one.id).status, "paused");
  assert.equal(f.rebuilds.get(two.id).status, "paused");
  await assert.rejects(f.rebuilds.start({ request: "Late" }), { status: 409 });
});

test("close fits the shutdown budget when every stop hangs", async (t) => {
  const f = rebuildsFixture(t, {
    script: { slowTools: { rebuild_stop: 60000 }, ignoreStdinClose: true },
  });
  const one = await f.rebuilds.start({ request: "One", accountId: "acc-a" });
  const two = await f.rebuilds.start({ request: "Two", accountId: "acc-b" });
  const pids = [
    ...[one, two].map((view) => f.craftRecord(view).fake_builder.pid),
    ...f.clients.map((client) => client.pid),
  ];
  const began = Date.now();
  await f.rebuilds.close();
  const took = Date.now() - began;
  assert.ok(took < 4000, `close took ${took} ms`);
  assert.ok(await until(() => !pids.some(exists), 2000));
  assert.equal(f.rebuilds.get(one.id).status, "paused");
});

test("a rebuild running at shutdown reads paused after restart", async (t) => {
  const f = rebuildsFixture(t);
  const view = await f.rebuilds.start({ request: "Survive" });
  const file = path.join(f.dataDir, "craft-rebuilds", "rebuilds.json");
  // A crash: the file still says running, the processes are gone.
  const crashed = fs.readFileSync(file, "utf8");
  assert.equal(JSON.parse(crashed).rebuilds[0].running, true);
  await f.rebuilds.close();
  fs.writeFileSync(file, crashed);
  const next = f.create();
  assert.equal(next.get(view.id).status, "building");
  await next.restore();
  assert.equal(next.get(view.id).status, "paused");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).rebuilds[0].status, "paused");
  const resumed = await next.continue(view.id);
  assert.equal(resumed.status, "building");
  assert.equal(exists(f.craftRecord(view).fake_builder.pid), true);
});

test("restore leaves rebuilds this server started alone and announces the paused", async (t) => {
  const f = rebuildsFixture(t);
  const old = await f.rebuilds.start({ request: "Old" });
  const file = path.join(f.dataDir, "craft-rebuilds", "rebuilds.json");
  const crashed = fs.readFileSync(file, "utf8");
  await f.rebuilds.close();
  fs.writeFileSync(file, crashed);
  const next = f.create();
  const changes = [];
  next.onChange((event) => changes.push(event));
  // Started after the server listened, before restore() ran.
  const fresh = await next.start({ request: "Fresh" });
  await next.restore();
  assert.equal(next.get(old.id).status, "paused");
  assert.equal(next.get(fresh.id).status, "building");
  assert.ok(changes.some((event) => event.list));
  assert.deepEqual(next.eligibleAccounts(), [
    { id: "local-claude", name: "Local" },
    { id: "acc-a", name: "A" },
    { id: "acc-b", name: "B" },
  ]);
});

test("an idle child closes after 60 s", async (t) => {
  const timers = fakeTimers();
  const f = rebuildsFixture(t, { timers, script: { steps: [{ finish: "ready" }] } });
  const view = await f.rebuilds.start({ request: "Idle" });
  const [client] = f.clients;
  assert.ok(
    await until(() => {
      timers.advance(2000);
      return f.rebuilds.get(view.id).status === "ready";
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The idle close was armed within the last 2 s of fake time.
  timers.advance(55000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.alive, true);
  timers.advance(5000);
  assert.ok(await until(() => !client.alive));
  assert.ok(await until(() => !exists(client.pid)));
  // A later call starts a fresh child.
  const { lines } = await f.rebuilds.activity(view.id, { limit: 5 });
  assert.ok(lines.length > 0);
  assert.equal(f.clients.length, 2);
});

test("refuses when Craft Anything is not installed", async (t) => {
  const f = rebuildsFixture(t, { installed: false });
  await assert.rejects(f.rebuilds.start({ request: "Nope" }), {
    status: 409,
    message: "Craft Anything ist nicht installiert.",
  });
  assert.deepEqual(fs.readdirSync(f.projectsDir), []);
  assert.equal(f.rebuilds.list().length, 0);
});

test("a start Craft Anything refuses leaves no folder behind", async (t) => {
  const f = rebuildsFixture(t, { script: { hideTools: ["rebuild_start"] } });
  await assert.rejects(f.rebuilds.start({ request: "Refused" }), { status: 409 });
  assert.deepEqual(fs.readdirSync(f.projectsDir), []);
  assert.equal(f.projects.length, 0);
  assert.equal(f.rebuilds.list().length, 0);
});

test("settings keep the owner's defaults", async (t) => {
  const f = rebuildsFixture(t);
  assert.deepEqual(f.rebuilds.settings(), {
    accountId: "local-claude",
    mode: "clean-room",
    autoMode: false,
  });
  await f.rebuilds.saveSettings({ accountId: "acc-a", mode: "deep", autoMode: true });
  assert.deepEqual(f.create().settings(), {
    accountId: "acc-a",
    mode: "deep",
    autoMode: true,
  });
  await assert.rejects(f.rebuilds.saveSettings({ accountId: "acc-provider" }), {
    status: 409,
  });
  await assert.rejects(f.rebuilds.saveSettings({ mode: "loud" }), { status: 400 });
  fs.writeFileSync(path.join(f.dataDir, "craft-rebuilds", "rebuilds.json"), "{broken");
  assert.equal(f.create().settings().mode, "clean-room");
});

test("a rebuild still starting is never sampled as paused and pauses after its start", async (t) => {
  const f = rebuildsFixture(t, { script: { slowTools: { rebuild_start: 600 } } });
  const first = await f.rebuilds.start({ request: "First" });
  const seen = [];
  f.rebuilds.onChange(() => {
    const second = f.rebuilds.list().find((item) => item.id !== first.id);
    if (second) seen.push(second.status);
  });
  const starting = f.rebuilds.start({ request: "Second" });
  assert.ok(await until(() => f.rebuilds.list().length === 2));
  const id = f.rebuilds.list().find((item) => item.id !== first.id).id;
  // Ticks of the first rebuild run meanwhile (sampleMs 50).
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.rebuilds.get(id).status, "starting");
  assert.equal((await f.rebuilds.pause(id)).status, "starting");
  const view = await starting;
  assert.equal(view.status, "paused");
  assert.ok(!seen.slice(0, -1).includes("paused"), `seen ${seen}`);
  const builder = f.craftRecord(view).fake_builder.pid;
  assert.ok(await until(() => !exists(builder)));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(f.rebuilds.get(id).status, "paused");
  assert.equal(f.rebuilds.get(first.id).status, "building");
});

test("a failed auto-mode allow is retried on the next tick", async (t) => {
  let failures = 0;
  const f = rebuildsFixture(t, {
    script: { steps: [approval, { finish: "ready" }] },
    intercept: (name, args) => {
      if (name === "project_inbox_answer" && args.allow && failures++ === 0)
        throw Object.assign(new Error("flaky"), { code: "busy" });
    },
  });
  const view = await f.rebuilds.start({ request: "Retry", autoMode: true });
  assert.ok(await settled(f.rebuilds, view.id, "ready"));
  assert.equal(failures, 2, "the first allow failed, the second went through");
  assert.ok(
    f.craftRecord(view).conversation.some((e) => e.text === "Run npm install?: allowed"),
  );
  assert.equal(f.rebuilds.sampler.approving.size, 0, "answered approvals are forgotten");
});

test("an approval auto mode fails to allow three times goes to the owner", async (t) => {
  let allows = 0;
  const f = rebuildsFixture(t, {
    script: { steps: [approval, { finish: "ready" }] },
    intercept: (name, args) => {
      if (name === "project_inbox_answer" && args.allow && ++allows <= AUTO_ALLOW_TRIES)
        throw Object.assign(new Error("flaky"), { code: "busy" });
    },
  });
  const view = await f.rebuilds.start({ request: "Give up", autoMode: true });
  const open = () => f.rebuilds.get(view.id).questions;
  assert.ok(await until(() => open()[0]?.autoFailed === true));
  assert.equal(allows, AUTO_ALLOW_TRIES);
  // The inbox and a push take it like any approval.
  assert.deepEqual(
    ownerQuestions(f.rebuilds.get(view.id)).map((question) => question.id),
    [open()[0].id],
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(allows, AUTO_ALLOW_TRIES, "no more tries");
  await f.rebuilds.answer(view.id, open()[0].id, { allow: true });
  assert.ok(await settled(f.rebuilds, view.id, "ready"));
  assert.equal(f.rebuilds.sampler.failures.size, 0, "forgotten once answered");
});

test("a new activity line changes the rebuild's view while it runs", async (t) => {
  let failing = false;
  const f = rebuildsFixture(t, {
    script: {
      steps: [{ wait: 300 }, { activity: "Reading the target" }, { wait: 10000 }],
    },
    intercept: (name) => {
      if (name === "rebuild_activity_show" && failing)
        throw Object.assign(new Error("busy"), { code: "busy" });
    },
  });
  const view = await f.rebuilds.start({ request: "Watch me" });
  const first = f.rebuilds.get(view.id).activityRevision;
  assert.match(first, /^[0-9a-f]{16}$/);
  const changes = [];
  f.rebuilds.onChange((event) => changes.push(event));
  assert.ok(await until(() => f.rebuilds.get(view.id).activityRevision !== first));
  assert.ok(
    changes.some((event) => event.id === view.id),
    "the topic is signalled",
  );
  const { lines } = await f.rebuilds.activity(view.id);
  assert.ok(lines.at(-1).endsWith("Reading the target"));
  // A failed read keeps the revision.
  const known = f.rebuilds.get(view.id).activityRevision;
  failing = true;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(f.rebuilds.get(view.id).activityRevision, known);
  assert.equal(f.rebuilds.get(view.id).status, "building");
});

test("a child killed from outside leaves its rebuild paused and no builder", async (t) => {
  const f = rebuildsFixture(t);
  const view = await f.rebuilds.start({ request: "Killed" });
  const builder = f.craftRecord(view).fake_builder.pid;
  process.kill(f.clients[0].pid, "SIGKILL");
  assert.ok(await settled(f.rebuilds, view.id, "paused"));
  assert.equal(f.rebuilds.get(view.id).step, "build");
  assert.ok(await until(() => !exists(builder)));
  const resumed = await f.rebuilds.continue(view.id);
  assert.equal(resumed.status, "building");
  assert.equal(f.clients.length, 2);
});
