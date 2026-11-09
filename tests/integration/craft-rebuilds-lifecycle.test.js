import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";
import {
  exists,
  fakeTimers,
  rebuildsFixture,
  until,
} from "../helpers/craft-rebuilds-fixture.js";

/** The pids of the processes whose command line mentions `text`. */
const processesWith = (text) =>
  execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(text))
    .map((line) => Number(line.trim().split(/\s+/)[0]));

test("a malformed rebuild_start answer stops the build it started", async (t) => {
  const f = rebuildsFixture(t, { script: { emptyTools: ["rebuild_start"] } });
  await assert.rejects(f.rebuilds.start({ request: "Malformed" }), { status: 409 });
  assert.deepEqual(fs.readdirSync(f.projectsDir), []);
  assert.equal(f.rebuilds.list().length, 0);
  assert.ok(
    await until(() => processesWith(`fake-craft-builder ${f.projectsDir}`).length === 0),
    "no builder is left in the removed folder",
  );
});

test("close does not wait for a child that never finishes initialize", async (t) => {
  const f = rebuildsFixture(t, { script: { silentInit: true } });
  const starting = f.rebuilds.start({ request: "Silent" }).catch((error) => error);
  assert.ok(await until(() => f.launched.length === 1));
  const [client] = f.launched;
  const began = Date.now();
  await f.rebuilds.close();
  const took = Date.now() - began;
  assert.ok(took < 3500, `close took ${took} ms`);
  assert.ok(await until(() => !exists(client.pid), 2000), "the child is killed");
  assert.equal((await starting).status, 409);
});

test("a running rebuild or a live child keeps Craft Anything in use", async (t) => {
  const timers = fakeTimers();
  const f = rebuildsFixture(t, { timers, script: { steps: [{ finish: "ready" }] } });
  assert.equal(f.rebuilds.inUse(), false);
  const view = await f.rebuilds.start({ request: "Busy" });
  assert.equal(f.rebuilds.inUse(), true);
  assert.ok(
    await until(() => {
      timers.advance(2000);
      return f.rebuilds.get(view.id).status === "ready";
    }),
  );
  // Ready, but its child still runs until the idle close.
  assert.equal(f.rebuilds.inUse(), true);
  timers.advance(60000);
  assert.ok(await until(() => !f.rebuilds.inUse()));
});

test("a rebuild keeps the project its folder has after git init", async (t) => {
  const f = rebuildsFixture(t);
  const view = await f.rebuilds.start({ request: "Registered" });
  const again = await f.memory.register(view.folder);
  assert.equal(again.id, view.projectId);
  assert.equal(f.projects.length, 1);
  assert.equal(f.create().get(view.id).projectId, again.id, "the stored record too");
});

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const childrenFile = (f) => path.join(f.dataDir, "craft-rebuilds", "children.json");
const rebuildsFile = (f) => path.join(f.dataDir, "craft-rebuilds", "rebuilds.json");

test("after a crash, restore ends the children and builders left running", async (t) => {
  const f = rebuildsFixture(t);
  const view = await f.rebuilds.start({ request: "Crash" });
  const builder = f.craftRecord(view).fake_builder.pid;
  const child = f.clients[0].pid;
  const recorded = JSON.parse(fs.readFileSync(childrenFile(f), "utf8")).children;
  const groups = recorded[String(child)];
  assert.ok(groups[String(child)], "the child's own group is recorded");
  assert.ok(
    Object.values(groups).some((members) => members.some((m) => m.pid === builder)),
    "the builder's group is recorded",
  );
  for (const members of Object.values(groups))
    for (const m of members) assert.match(m.command, /^[0-9a-f]{64}$/, "only a digest");
  // A crash: the next server starts while the old processes still run.
  const next = f.create();
  assert.equal(next.get(view.id).status, "building");
  await next.restore();
  assert.ok(await until(() => !exists(builder) && !exists(child)));
  assert.equal(next.get(view.id).status, "paused");
});

test("a clean close forgets the children's processes", async (t) => {
  const f = rebuildsFixture(t);
  await f.rebuilds.start({ request: "Clean" });
  await f.rebuilds.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(childrenFile(f), "utf8")).children, {});
});

test("restore leaves a process alone whose pid or group was reused", async (t) => {
  const f = rebuildsFixture(t);
  const other = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  t.after(() => {
    try {
      process.kill(-other.pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  });
  fs.mkdirSync(path.dirname(childrenFile(f)), { recursive: true });
  const write = (command) =>
    fs.writeFileSync(
      childrenFile(f),
      JSON.stringify({
        version: 1,
        children: { 1: { [other.pid]: [{ pid: other.pid, command: sha256(command) }] } },
      }),
    );
  write("/opt/craft-anything-cli mcp --all-tools --allow-run --clean-room");
  await f.create().restore();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(exists(other.pid), true, "another command keeps running");
  write(
    execFileSync("ps", ["-o", "command=", "-p", String(other.pid)], {
      encoding: "utf8",
    }).trim(),
  );
  await f.create().restore();
  assert.ok(await until(() => !exists(other.pid)), "the recorded command is ended");
});

test("a child a view started before restore idles out after it", async (t) => {
  const timers = fakeTimers();
  const f = rebuildsFixture(t, { timers });
  const view = await f.rebuilds.start({ request: "Viewed" });
  const crashed = fs.readFileSync(rebuildsFile(f), "utf8");
  await f.rebuilds.close();
  fs.writeFileSync(rebuildsFile(f), crashed);
  const next = f.create();
  await next.activity(view.id);
  const client = f.clients.at(-1);
  await next.restore();
  assert.equal(next.get(view.id).status, "paused");
  timers.advance(60000);
  assert.ok(await until(() => !client.alive));
});

test("a pause drops its questions and Continue shows only the ones asked again", async (t) => {
  const approval = { ask: "approval", title: "Run npm install?", action: "npm install" };
  const asked = [];
  const f = rebuildsFixture(t, {
    script: { steps: [approval, { finish: "ready" }] },
    intercept: (name, args) => name === "project_inbox_answer" && asked.push(args.id),
  });
  const view = await f.rebuilds.start({ request: "Stale" });
  assert.ok(await until(() => f.rebuilds.get(view.id).questions.length === 1));
  const [stale] = f.rebuilds.get(view.id).questions;
  // Paused: the builder that asked is gone, though Craft Anything still lists it.
  assert.deepEqual((await f.rebuilds.pause(view.id)).questions, []);
  assert.equal(f.craftRecord(view).questions.length, 1);
  await f.rebuilds.continue(view.id);
  assert.ok(await until(() => f.rebuilds.get(view.id).questions.length === 1));
  assert.equal(f.craftRecord(view).questions.length, 2, "Craft lists both");
  const [again] = f.rebuilds.get(view.id).questions;
  assert.notEqual(again.id, stale.id);
  await assert.rejects(f.rebuilds.answer(view.id, stale.id, { allow: true }), {
    status: 409,
    message: serverMessages.craft.rebuildQuestionGone,
  });
  assert.deepEqual(asked, [], "the old one is never answered");
  await f.rebuilds.answer(view.id, again.id, { allow: true });
  assert.ok(await until(() => f.rebuilds.get(view.id).status === "ready"));
});

test("a pause holds while Craft Anything still reports the build stopping", async (t) => {
  const f = rebuildsFixture(t, { script: { stopLagMs: 600 } });
  const view = await f.rebuilds.start({ request: "Lagging" });
  const statuses = [];
  f.rebuilds.onChange(() => statuses.push(f.rebuilds.get(view.id).status));
  assert.equal((await f.rebuilds.pause(view.id)).status, "paused");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.rebuilds.get(view.id).status, "paused");
  assert.ok(!statuses.includes("building"), `seen ${statuses}`);
  assert.equal((await f.rebuilds.continue(view.id)).status, "building");
});

test("a snapshot does not wait for a slow rebuild_start", async (t) => {
  const barrier = new MutationBarrier();
  const f = rebuildsFixture(t, {
    barrier,
    script: { slowTools: { rebuild_start: 1500 } },
  });
  const leased = [];
  const register = f.memory.register;
  f.memory.register = (cwd) => {
    leased.push(barrier.hasLease());
    return register(cwd);
  };
  const starting = f.rebuilds.start({ request: "Slow" });
  assert.ok(await until(() => f.rebuilds.list().length === 1));
  const began = Date.now();
  await barrier.snapshot(async () => {});
  assert.ok(Date.now() - began < 1000, "the snapshot ran while rebuild_start waited");
  assert.equal(f.rebuilds.list()[0].status, "starting");
  const view = await starting;
  assert.equal(view.status, "building");
  assert.deepEqual(leased, [true, true], "folder and Git project under a lease");
});
