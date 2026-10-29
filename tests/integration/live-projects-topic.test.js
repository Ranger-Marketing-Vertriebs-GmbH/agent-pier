import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";

// The projects page's `projects.changed` signal: a new project row (here registered
// directly, as an agent creating its own project or a session does) sends `changed`;
// a registration that leaves the rows as they were sends nothing.

const changedFrame = (frame) =>
  frame.topic === "projects.changed" && frame.type === "changed";

test("a registered project signals projects.changed, an unchanged one does not", async (t) => {
  const f = await applicationFixture(t);
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "projects.changed" });
  const first = await live.next((frame) => frame.topic === "projects.changed", 5000);
  assert.equal(first.type, "same");
  const memory = f.application.memory;
  const folder = path.join(path.dirname(f.project), "agent-made");
  await fs.mkdir(folder, { mode: 0o700 });
  const signalled = live.next(changedFrame, 2000);
  await memory.register(folder);
  assert.equal((await signalled).type, "changed");
  // The same folder again: the rows did not change.
  await memory.register(folder);
  await assert.rejects(live.next(changedFrame, 400), /no matching frame/);
  // Removing the empty row signals again.
  const removed = live.next(changedFrame, 2000);
  const id = memory.projects().projects.find((p) => p.cwd === folder).id;
  assert.equal(memory.removeEmpty(id), true);
  assert.equal((await removed).type, "changed");
  live.ws.close();
});

test("the route registration signals projects.changed", async (t) => {
  const f = await applicationFixture(t);
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "projects.changed" });
  await live.next((frame) => frame.topic === "projects.changed", 5000);
  const signalled = live.next(changedFrame, 2000);
  const answer = await f.request("/api/memory/projects", {
    method: "POST",
    body: { cwd: f.project },
  });
  assert.equal(answer.status, 201);
  assert.equal((await signalled).type, "changed");
  live.ws.close();
});
