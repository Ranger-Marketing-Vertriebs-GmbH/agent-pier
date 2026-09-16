import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

async function fixture(t, headless = false) {
  const f = await applicationFixture(t);
  const project = path.join(f.home, "project");
  await fs.mkdir(project);
  f.application.sessions.get = async () => ({
    id: "fixture",
    cwd: project,
    pipeline: { headless },
  });
  return {
    ...f,
    project,
    create: (parent, name) =>
      f.request("/api/sessions/fixture/files", {
        method: "POST",
        body: { path: parent, name },
      }),
  };
}

test("legacy folder creation rejects headless sessions without writing", async (t) => {
  const f = await fixture(t, true);
  const response = await f.create("", "blocked");
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "FILE_READ_ONLY");
  assert.deepEqual(await fs.readdir(f.project), []);
});

test("legacy folder creation retains synchronous relative paths and rejects occupied names", async (t) => {
  const f = await fixture(t);
  const response = await f.create("", "parent");
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { path: "parent" });
  const child = await f.create("parent", "child");
  assert.equal(child.status, 201);
  assert.deepEqual(await child.json(), { path: "parent/child" });
  const duplicate = await f.create("parent", "child");
  assert.equal(duplicate.status, 409);
  assert.ok((await fs.stat(path.join(f.project, "parent/child"))).isDirectory());
});

test("legacy folder creation cannot follow a parent replaced after its stat", async (t) => {
  const f = await fixture(t);
  const parent = path.join(f.project, "parent");
  const outside = path.join(f.home, "outside");
  await fs.mkdir(parent);
  await fs.mkdir(outside);
  let replaced = false;
  for (const method of ["stat", "lstat"]) {
    const original = fs[method];
    t.mock.method(fs, method, async (target, ...args) => {
      const stat = await original(target, ...args);
      if (target === parent && !replaced) {
        replaced = true;
        await fs.rename(parent, `${parent}-old`);
        await fs.symlink(outside, parent);
      }
      return stat;
    });
  }
  const response = await f.create("parent", "child");
  assert.equal(replaced, true);
  assert.ok(response.status >= 400, `unexpected HTTP ${response.status}`);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("legacy folder creation rejects parent replacement after staging without publishing outside", async (t) => {
  const f = await fixture(t);
  const parent = path.join(f.project, "parent");
  const outside = path.join(f.home, "outside");
  await fs.mkdir(parent);
  await fs.mkdir(outside);
  const publisher = f.application.files.publisher;
  const originalStage = publisher.stage.bind(publisher);
  let replaced = false;
  t.mock.method(publisher, "stage", async (...args) => {
    const stage = await originalStage(...args);
    replaced = true;
    await fs.rename(parent, `${parent}-old`);
    await fs.symlink(outside, parent);
    return stage;
  });
  const response = await f.create("parent", "child");
  assert.equal(replaced, true);
  assert.ok(response.status >= 400, `unexpected HTTP ${response.status}`);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(fs.stat(path.join(`${parent}-old`, "child")), {
    code: "ENOENT",
  });
});

test("legacy folder creation reports unavailable jobs after shutdown without writing", async (t) => {
  const f = await fixture(t);
  await f.application.files.close();
  const response = await f.create("", "closed");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "FILE_JOBS_CLOSED");
  assert.deepEqual(await fs.readdir(f.project), []);
});

test("legacy folder creation retains single trimmed child name validation", async (t) => {
  const f = await fixture(t);
  for (const name of [
    " ",
    " leading",
    "trailing ",
    "a\\b",
    "../escape",
    "a/b",
    ".",
    "..",
    "",
    null,
  ]) {
    const response = await f.create("", name);
    assert.equal(response.status, 400, JSON.stringify(name));
  }
  assert.deepEqual(await fs.readdir(f.project), []);
});
