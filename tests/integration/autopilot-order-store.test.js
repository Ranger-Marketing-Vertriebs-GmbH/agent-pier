import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { once, EventEmitter } from "node:events";
import test from "node:test";
import { OrderStore } from "../../server/features/autopilot/order-store.js";
import { projectScope } from "../../server/features/memory/project-scope.js";

async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-orders-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const cwd = path.join(temp, "project");
  fs.mkdirSync(cwd);
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args]);
  git("init", "--quiet");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@invalid.test",
    "commit",
    "--allow-empty",
    "-qm",
    "seed",
  );
  const project = await projectScope(cwd);
  const events = new EventEmitter();
  const options = {
    dataDir: path.join(temp, "data"),
    projects: () => [project],
    onChange: (projectId, id) => events.emit("change", projectId, id),
  };
  const open = () => {
    const store = new OrderStore(options);
    t.after(() => store.close());
    return store;
  };
  const input = {
    requestId: "request-1",
    title: "Repeated title",
    brief: "A local task",
  };
  const directory = path.join(cwd, ".git", "agentpier-composer");
  return { temp, project, events, open, input, directory, git };
}

test("concurrent retries share a durable receipt; a second same-title order remains independent", async (t) => {
  const { project, open, input } = await fixture(t);
  const store = open();
  const [a, retry] = await Promise.all([
    store.create(project.id, input),
    store.create(project.id, input),
  ]);
  assert.equal(a.ref.id, retry.ref.id);
  const resumed = await open().create(project.id, input);
  assert.equal(resumed.ref.id, a.ref.id);
  assert.equal(a.document.allowMerge, false);
  assert.equal(a.document.manualPaused, false);
  await assert.rejects(store.create(project.id, { ...input, brief: "Changed" }), {
    status: 409,
  });
  const b = await store.create(project.id, { ...input, requestId: "different" });
  assert.notEqual(a.ref.id, b.ref.id);
  await store.update(a.ref.id, (doc) => ({ ...doc, allowMerge: true }));
  assert.equal((await open().get(a.ref.id)).document.allowMerge, true);
  assert.equal((await store.get(b.ref.id)).document.allowMerge, false);
});

test("a legacy order discovered from another checkout retains its file, identity and limits", async (t) => {
  const { project, open, directory, git, temp } = await fixture(t);
  const linked = path.join(temp, "linked");
  git("worktree", "add", "--detach", "--quiet", linked);
  project.cwd = linked;
  fs.mkdirSync(directory);
  const file = path.join(directory, "historical.json");
  const original =
    '{"title":"Old","projectId":"foreign","worktree":"/somewhere","batches":[]}';
  fs.writeFileSync(file, original);
  fs.symlinkSync(file, path.join(directory, "not-another-order.json"));
  const store = open();
  const [order, ...extra] = await store.list();
  assert.equal(extra.length, 0);
  assert.equal(order.ref.projectId, project.id);
  assert.equal(order.ref.managed, false);
  assert.ok(order.limitations.includes("missingId"));
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal((await open().list())[0].ref.id, order.ref.id);
  await assert.rejects(store.remove(order.ref.id));
});

test("watch the first external order and atomic replacements without a browser timer", async (t) => {
  const { open, events, project, directory } = await fixture(t);
  const store = open();
  assert.deepEqual(await store.list(), []);
  const changed = () => once(events, "change", { signal: AbortSignal.timeout(10000) });
  let next = changed();
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "order.json"), '{"title":"one"}');
  assert.equal((await next)[0], project.id);
  const [order] = await store.list();
  next = changed();
  fs.writeFileSync(path.join(directory, "next.tmp"), '{"title":"two"}');
  fs.renameSync(path.join(directory, "next.tmp"), path.join(directory, "order.json"));
  assert.equal((await next)[0], project.id);
  assert.equal((await store.get(order.ref.id)).document.title, "two");
});

test("a replaced composer directory never redirects reads, writes or cleanup", async (t) => {
  const { open, project, input, temp, directory } = await fixture(t);
  const store = open();
  const { ref } = await store.create(project.id, input);
  const unrelated = path.join(temp, "elsewhere");
  fs.mkdirSync(unrelated);
  const sentinel = path.join(unrelated, ref.filename);
  fs.writeFileSync(sentinel, JSON.stringify({ id: ref.id, title: "private" }));
  fs.renameSync(directory, directory + "-old");
  fs.symlinkSync(unrelated, directory);
  assert.equal((await store.get(ref.id)).document, null);
  await assert.rejects(store.update(ref.id, (doc) => ({ ...doc, allowMerge: true })));
  await store.setReference(ref.id, { cleanup: "removing" });
  await assert.rejects(store.remove(ref.id));
  assert.equal(JSON.parse(fs.readFileSync(sentinel)).title, "private");
});

test("cleanup retries after file removal, tombstones the name and the creation receipt", async (t) => {
  const { open, project, input, directory } = await fixture(t);
  const store = open();
  const { ref, document } = await store.create(project.id, input);
  await assert.rejects(store.remove(ref.id));
  await store.setReference(ref.id, { cleanup: "resourcesRemoved" });
  fs.unlinkSync(path.join(directory, ref.filename));
  const reopened = open();
  await reopened.remove(ref.id);
  fs.writeFileSync(path.join(directory, ref.filename), JSON.stringify(document));
  assert.deepEqual(await reopened.list(), []);
  await assert.rejects(reopened.create(project.id, input), { status: 410 });
});

test("the shipped progress helper preserves controls and rejects edits to paused work or policy", async (t) => {
  const { open, project, input, directory, temp } = await fixture(t);
  const store = open();
  const { ref } = await store.create(project.id, input);
  const original = path.resolve(
    "server/features/cli-profiles/skills/agentpier-composer/scripts/order-progress.mjs",
  );
  const helper = path.join(temp, "managed-helper.mjs");
  fs.symlinkSync(original, helper);
  const update = (patch) =>
    execFileSync(process.execPath, [helper, ref.filename], {
      cwd: project.cwd,
      input: JSON.stringify(patch),
      stdio: ["pipe", "pipe", "pipe"],
    });
  await store.update(ref.id, (doc) => ({
    ...doc,
    allowMerge: true,
    privateExtension: "keep",
  }));
  update({ batches: [{ id: "b1", items: [{ id: "one" }] }], checkpoint: "Saved" });
  assert.throws(() => update({ allowMerge: false }));
  assert.throws(() => update({ implementationAuthorized: true }));
  assert.throws(() => update({ batches: [{ id: "b1" }, { id: "b1" }] }));
  await store.update(ref.id, (doc) => ({ ...doc, manualPaused: true }));
  assert.throws(() => update({ batches: [] }));
  update({ checkpoint: "Paused" });
  const saved = (await store.get(ref.id)).document;
  assert.equal(saved.id, ref.id);
  assert.equal(saved.batches[0].items[0].id, "one");
  assert.equal(saved.allowMerge, true);
  assert.equal(saved.implementationAuthorized, false);
  assert.equal(saved.privateExtension, "keep");
  assert.equal(saved.checkpoint, "Paused");
  assert.equal(fs.statSync(path.join(directory, ref.filename)).mode & 0o777, 0o600);
});

test("an interrupted creation publishes the same reserved file on retry", async (t) => {
  const { open, project, input, directory, temp } = await fixture(t);
  const store = open();
  const elsewhere = path.join(temp, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, directory);
  await assert.rejects(store.create(project.id, input), { status: 409 });
  const [pending] = await store.list();
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  fs.unlinkSync(directory);
  const { ref, document } = await open().create(project.id, input);
  assert.equal(ref.id, pending.ref.id);
  assert.equal(document.id, ref.id);
  assert.equal((await store.list()).length, 1);
});
