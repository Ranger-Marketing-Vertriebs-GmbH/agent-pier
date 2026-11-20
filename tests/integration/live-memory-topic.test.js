import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";

// The Knowledge tab's `memory.changed:<projectId>` signal: every entry write (a new
// entry, an edit, archiving, forgetting) and a merge into the project sends `changed`
// to followers of that project only.

const changed = (topic) => (frame) => frame.topic === topic && frame.type === "changed";

async function follow(f, projectId) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  const topic = `memory.changed:${projectId}`;
  live.send({ op: "sub", topic });
  const first = await live.next((frame) => frame.topic === topic, 5000);
  assert.equal(first.type, "same");
  return { live, topic };
}

test("entry writes, archiving and forgetting signal their project's memory topic", async (t) => {
  const f = await applicationFixture(t);
  const memory = f.application.memory;
  const project = await memory.register(f.project);
  const other = path.join(path.dirname(f.project), "other-knowledge");
  await fs.mkdir(other, { mode: 0o700 });
  const second = await memory.register(other);
  const { live, topic } = await follow(f, project.id);
  // A session's memory_write and memory_archive go through the same methods.
  let signalled = live.next(changed(topic), 2000);
  const entry = memory.write(
    project.id,
    { title: "Deploy", content: "Use the staging host." },
    { kind: "session", sessionId: "s1", accountId: "local-codex", tool: "codex" },
  );
  assert.equal((await signalled).type, "changed");
  signalled = live.next(changed(topic), 2000);
  memory.archive(project.id, entry.id, { expectedRevision: entry.revision });
  assert.equal((await signalled).type, "changed");
  // Another project's write is not this project's change.
  memory.write(second.id, { title: "Other", content: "x" });
  await assert.rejects(live.next(changed(topic), 400), /no matching frame/);
  // The owner forgets the entry through the route.
  signalled = live.next(changed(topic), 2000);
  const archived = memory.read(project.id, entry.id);
  const answer = await f.request(
    `/api/memory/projects/${project.id}/entries/${entry.id}`,
    { method: "DELETE", body: { expectedRevision: archived.revision } },
  );
  assert.ok(answer.status < 300, JSON.stringify(answer.body));
  assert.equal((await signalled).type, "changed");
  live.ws.close();
});

test("a merge signals the project it merged into and the one merged away", async (t) => {
  const f = await applicationFixture(t);
  const memory = f.application.memory;
  const project = await memory.register(f.project);
  const other = path.join(path.dirname(f.project), "merged-away");
  await fs.mkdir(other, { mode: 0o700 });
  const from = await memory.register(other);
  const into = await follow(f, project.id);
  const away = await follow(f, from.id);
  const both = Promise.all([
    into.live.next(changed(into.topic), 2000),
    away.live.next(changed(away.topic), 2000),
  ]);
  memory.merge(from.id, memory.scopeOf(project.id));
  await both;
  into.live.ws.close();
  away.live.ws.close();
});
