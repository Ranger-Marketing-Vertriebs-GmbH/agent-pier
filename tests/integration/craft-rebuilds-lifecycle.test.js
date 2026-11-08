import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
