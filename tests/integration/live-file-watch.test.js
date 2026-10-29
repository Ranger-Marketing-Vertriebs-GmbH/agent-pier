import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import {
  DirectoryWatchers,
  FILE_WATCH_HEADER,
} from "../../server/features/files/file-watch-topic.js";

// Task 5.2: `file.meta:<token>`, the editor's document metadata pushed on change. The
// token comes from the document metadata route (X-File-Watch) after its own checks;
// the topic watches the file's directory, so in-place writes, atomic replaces,
// deletes and re-creates all push within a second.

const TOKEN = /^file\.meta:[A-Za-z0-9_-]{22}$/;

async function watchOf(f, file, prefix = "/api/files") {
  const query = new URLSearchParams({ path: file, view: "document" });
  const response = await f.request(`${prefix}/metadata?${query}`);
  const body = await response.json();
  return {
    status: response.status,
    body,
    topic: response.headers.get(FILE_WATCH_HEADER),
  };
}

async function subscribed(f, topic) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic });
  const first = await live.next((frame) => frame.topic === topic, 5000);
  return { live, first };
}

const pushed = (live, topic, predicate) =>
  live.next(
    (frame) => frame.topic === topic && frame.type === "state" && predicate(frame.data),
    1000,
  );

test("an external write, an atomic replace, a delete and a re-create push within a second", async (t) => {
  const f = await applicationFixture(t);
  const file = path.join(f.home, "notes.txt");
  await fs.writeFile(file, "one");
  const { status, body, topic } = await watchOf(f, file);
  assert.equal(status, 200);
  // The REST answer keeps its shape; the topic travels in a header.
  assert.deepEqual(Object.keys(body).sort(), [
    "metadataRevision",
    "path",
    "resolvedPath",
  ]);
  assert.match(topic, TOKEN);
  // The same file in the same scope keeps its token.
  assert.equal((await watchOf(f, file)).topic, topic);
  const { live, first } = await subscribed(f, topic);
  t.after(() => live.ws.close());
  assert.equal(first.type, "snapshot");
  assert.deepEqual(first.data, { ...body, watched: true });

  await fs.appendFile(file, " two");
  const written = await pushed(live, topic, (data) => data.metadataRevision);
  assert.notEqual(written.data.metadataRevision, body.metadataRevision);
  assert.equal(
    written.data.metadataRevision,
    (await watchOf(f, file)).body.metadataRevision,
  );

  // An editor's save: a temporary file renamed over the original.
  const temporary = path.join(f.home, ".notes.txt.tmp");
  await fs.writeFile(temporary, "three");
  await fs.rename(temporary, file);
  const replaced = await pushed(
    live,
    topic,
    (data) =>
      data.metadataRevision && data.metadataRevision !== written.data.metadataRevision,
  );
  // The watch survives the replace: a later write still pushes.
  await fs.appendFile(file, " four");
  await pushed(
    live,
    topic,
    (data) =>
      data.metadataRevision && data.metadataRevision !== replaced.data.metadataRevision,
  );

  await fs.rm(file);
  const missing = await pushed(live, topic, (data) => data.missing === true);
  assert.deepEqual(missing.data, { path: file, missing: true, watched: true });
  await fs.writeFile(file, "back");
  const back = await pushed(live, topic, (data) => !data.missing);
  assert.equal(
    back.data.metadataRevision,
    (await watchOf(f, file)).body.metadataRevision,
  );
});

test("a file of another folder changes nothing, and nothing is pushed while nothing changes", async (t) => {
  const f = await applicationFixture(t);
  const file = path.join(f.home, "quiet.txt");
  await fs.writeFile(file, "quiet");
  const { topic } = await watchOf(f, file);
  const { watches } = f.application.files;
  const metadata = watches.metadata;
  let reads = 0;
  watches.metadata = (...args) => {
    reads += 1;
    return metadata(...args);
  };
  const { live } = await subscribed(f, topic);
  t.after(() => live.ws.close());
  // Reading the file is no change of it: the watch settles instead of reading on.
  await delay(600);
  const settled = reads;
  await delay(600);
  assert.equal(reads, settled);
  // A neighbour in the same folder reads again, but its digest is equal: no frame.
  await fs.writeFile(path.join(f.home, "other.txt"), "x");
  await delay(600);
  assert.deepEqual(
    live.frames.filter((frame) => frame.topic === topic).map((frame) => frame.type),
    ["snapshot"],
  );
});

test("the data directory, paths outside the scope and unknown tokens are not watched", async (t) => {
  const f = await applicationFixture(t);
  // The data directory reads over REST like any folder, but is never watched, also
  // through a link whose spelling hides it.
  const inside = path.join(f.dataDir, "watch-probe.txt");
  await fs.writeFile(inside, "private");
  await fs.symlink(f.dataDir, path.join(f.home, "data-link"));
  for (const file of [inside, path.join(f.home, "data-link", "watch-probe.txt")]) {
    const answer = await watchOf(f, file);
    assert.equal(answer.status, 200, file);
    assert.equal(answer.topic, null, file);
  }
  // A project scope: a link out of it is refused over REST and gets no token.
  const project = path.join(f.home, "project");
  const outside = path.join(f.home, "outside.txt");
  await fs.mkdir(project);
  await fs.writeFile(outside, "outside");
  await fs.writeFile(path.join(project, "target.txt"), "inside");
  await fs.symlink(outside, path.join(project, "out"));
  await fs.symlink("target.txt", path.join(project, "link"));
  await f.application.sessions.save({
    id: "watch-session",
    name: "watch fixture",
    tool: "shell",
    status: "exited",
    cwd: project,
  });
  const prefix = "/api/sessions/watch-session/files/explorer";
  const refused = await watchOf(f, "out", prefix);
  assert.equal(refused.status, 403);
  assert.equal(refused.topic, null);
  // A link inside it is watched until it points out: then the push carries the
  // refusal REST answers, never the outside file's metadata.
  const linked = await watchOf(f, "link", prefix);
  assert.match(linked.topic, TOKEN);
  const { live, first } = await subscribed(f, linked.topic);
  t.after(() => live.ws.close());
  assert.equal(first.data.resolvedPath, "target.txt");
  await fs.rm(path.join(project, "link"));
  await fs.symlink(outside, path.join(project, "link"));
  const moved = await pushed(live, linked.topic, (data) => data.error);
  assert.deepEqual(moved.data, {
    path: "link",
    error: { code: "FILE_OUTSIDE_SCOPE", status: 403 },
    watched: true,
  });
  assert.equal((await watchOf(f, "link", prefix)).status, 403);
  // A token nobody issued is unknown.
  for (const topic of [`file.meta:${"a".repeat(22)}`, "file.meta:short", "file.meta"]) {
    live.send({ op: "sub", topic });
    assert.deepEqual(await live.next((frame) => frame.topic === topic), {
      type: "error",
      topic,
      code: "unknown-topic",
    });
  }
});

test("only local scopes are registered, and a user cannot use the owner's token", async (t) => {
  const f = await applicationFixture(t);
  const { watches } = f.application.files;
  const file = path.join(f.home, "own.txt");
  await fs.writeFile(file, "own");
  const scope = await f.application.files.context(null);
  const owner = { role: "owner" };
  assert.equal(await watches.register(owner, { ...scope, kind: "ssh" }, file), null);
  const token = await watches.register(owner, scope, file);
  assert.match(token, TOKEN);
  // Registered for the owner: a user (even past the gate) is refused by the topic.
  const user = { role: "user", userId: "u1" };
  assert.equal(watches.authorize(user, token.slice("file.meta:".length)), false);
  assert.equal(watches.authorize(owner, token.slice("file.meta:".length)), true);
  // Directories and files are not watched.
  assert.equal(await watches.register(owner, scope, f.home), null);
});

test("one watcher per folder, shared, closed with the last subscriber, and capped", async (t) => {
  const f = await applicationFixture(t);
  const { watches } = f.application.files;
  const a = path.join(f.home, "a.txt");
  const b = path.join(f.home, "b.txt");
  await fs.writeFile(a, "a");
  await fs.writeFile(b, "b");
  const topics = [(await watchOf(f, a)).topic, (await watchOf(f, b)).topic];
  const live = openLive(f);
  t.after(() => live.ws.close());
  await live.next((frame) => frame.type === "hello");
  for (const topic of topics) {
    live.send({ op: "sub", topic });
    await live.next((frame) => frame.topic === topic && frame.type === "snapshot", 5000);
  }
  const deadline = Date.now() + 2000;
  while (watches.directories.size !== 1 && Date.now() < deadline) await delay(10);
  assert.equal(watches.directories.size, 1);
  live.send({ op: "unsub", topic: topics[0] });
  await delay(100);
  assert.equal(watches.directories.size, 1);
  live.send({ op: "unsub", topic: topics[1] });
  while (watches.directories.size && Date.now() < deadline + 2000) await delay(10);
  assert.equal(watches.directories.size, 0);
  // Past the cap a file is not watched: the push says so and the editor polls.
  watches.maxFiles = 1;
  live.send({ op: "sub", topic: topics[0] });
  const kept = await live.next((frame) => frame.topic === topics[0] && frame.data, 5000);
  assert.equal(kept.data.watched, true);
  live.send({ op: "sub", topic: topics[1] });
  const over = await live.next((frame) => frame.topic === topics[1] && frame.data, 5000);
  assert.equal(over.data.watched, false);
});

test("DirectoryWatchers shares one handle per folder, filters by name and honours its cap", () => {
  const made = [];
  const watch = (directory) => {
    const handle = new EventEmitter();
    handle.closed = false;
    handle.close = () => (handle.closed = true);
    made.push({ directory, handle });
    return handle;
  };
  const watchers = new DirectoryWatchers({ watch, maxDirectories: 1 });
  const calls = [];
  const releaseA = watchers.add("/d", "a.txt", () => calls.push("a"));
  const releaseB = watchers.add("/d", "b.txt", () => calls.push("b"));
  assert.equal(made.length, 1);
  assert.equal(
    watchers.add("/other", "c.txt", () => {}),
    null,
  );
  made[0].handle.emit("change", "rename", "a.txt");
  made[0].handle.emit("change", "change", "unrelated");
  // No name (some platforms): every listener of the folder hears it.
  made[0].handle.emit("change", "change", null);
  assert.deepEqual(calls, ["a", "a", "b"]);
  releaseA();
  assert.equal(made[0].handle.closed, false);
  releaseB();
  releaseB();
  assert.equal(made[0].handle.closed, true);
  assert.equal(watchers.size, 0);
  // A failing handle is dropped and its listeners hear it, to watch again.
  const heard = [];
  watchers.add("/e", "x", () => heard.push("x"));
  made[1].handle.emit("error", new Error("gone"));
  assert.deepEqual(heard, ["x"]);
  assert.equal(made[1].handle.closed, true);
  assert.equal(watchers.size, 0);
});
