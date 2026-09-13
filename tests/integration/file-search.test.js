import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { waitForFileJob } from "../helpers/file-explorer.js";

const operation = (source, kind = "search", options = {}) => ({
  requestId: `${Date.now()}:${randomUUID()}`,
  kind,
  sources: [source],
  target: null,
  name: null,
  options:
    kind === "search"
      ? {
          query: ".txt",
          recursive: true,
          hidden: false,
          caseSensitive: false,
          ...options,
        }
      : options,
});
async function start(f, op, base = "/api/files") {
  const context = await f.request(`${base}/context`);
  assert.equal(context.status, 200);
  const response = await f.request(`${base}/operations`, {
    method: "POST",
    headers: { "X-File-Scope": (await context.json()).scopeId },
    body: op,
  });
  assert.equal(response.status, 202, await response.clone().text());
  return waitForFileJob(f, (await response.json()).id, { base });
}

test("recursive filename search returns complete metadata and never follows links", async (t) => {
  const f = await applicationFixture(t);
  await fs.mkdir(path.join(f.home, "src"));
  await fs.writeFile(path.join(f.home, "src", "A.TXT"), "contents");
  await fs.writeFile(path.join(f.home, ".hidden.txt"), "hidden");
  await fs.writeFile(path.join(f.root, "escaping.txt"), "sentinel");
  await fs.symlink(f.root, path.join(f.home, "escape"));
  await fs.symlink(f.home, path.join(f.home, "cycle"));
  const job = await start(f, operation(f.home));
  assert.equal(job.status, "completed");
  assert.equal(job.issue, null);
  const response = await f.request(`/api/files/jobs/${job.id}/entries`);
  assert.equal(response.status, 200);
  const { entries } = await response.json();
  assert.equal(entries.length, 1);
  assert.deepEqual(
    Object.keys(entries[0]).sort(),
    [
      "id",
      "path",
      "name",
      "type",
      "size",
      "modifiedAt",
      "mode",
      "readable",
      "writable",
      "linkTarget",
      "revision",
    ].sort(),
  );
  assert.equal(entries[0].name, "A.TXT");
  assert.equal(entries[0].size, 8);
  assert.equal(entries[0].readable, true);
  assert.equal(entries[0].linkTarget, null);
  assert.match(entries[0].revision, /^e1:/);
  assert.equal(JSON.stringify(entries).includes("contents"), false);
  assert.deepEqual(
    (await (await f.request(`/api/files/jobs/${job.id}/entries`)).json()).entries,
    entries,
  );
  const sensitive = await start(f, operation(f.home, "search", { caseSensitive: true }));
  assert.deepEqual(
    (await (await f.request(`/api/files/jobs/${sensitive.id}/entries`)).json()).entries,
    [],
  );
  const shallow = await start(
    f,
    operation(f.home, "search", { recursive: false, hidden: true }),
  );
  assert.equal(
    (await (await f.request(`/api/files/jobs/${shallow.id}/entries`)).json()).entries[0]
      .name,
    ".hidden.txt",
  );
});

test("metadata scans and requested sizes exceed transfer budgets but retain search caps", async (t) => {
  const f = await applicationFixture(t, {
    files: {
      limits: {
        jobEntries: 1,
        jobBytes: 1,
        searchEntries: 4,
        searchResults: 3,
      },
    },
  });
  for (const name of ["a.txt", "b.txt", "c.txt"])
    await fs.writeFile(path.join(f.home, name), "123");
  const search = await start(f, operation(f.home));
  assert.equal(search.status, "completed");
  assert.equal(search.completedEntries, 3);
  const results = await (await f.request(`/api/files/jobs/${search.id}/entries`)).json();
  assert.equal(results.entries.length, 3);
  const size = await start(f, operation(f.home, "size"));
  assert.equal(size.status, "completed");
  assert.equal(size.issue, null);
  assert.equal(size.completedBytes, 9);
  assert.equal(size.totalBytes, 9);
  await fs.writeFile(path.join(f.home, "d.txt"), "123");
  const capped = await start(f, operation(f.home));
  assert.equal(capped.issue.code, "FILE_SEARCH_INCOMPLETE");
  assert.deepEqual(capped.issue.args, { reason: "results" });
});

test("search reports entry truncation as a durable safe issue", async (t) => {
  const f = await applicationFixture(t, { files: { limits: { searchEntries: 2 } } });
  await fs.mkdir(path.join(f.home, "src"));
  await fs.writeFile(path.join(f.home, "src", "a.txt"), "a");
  await fs.writeFile(path.join(f.home, "src", "b.txt"), "b");
  const job = await start(f, operation(f.home));
  assert.equal(job.completedEntries, 2);
  assert.deepEqual(job.issue, {
    code: "FILE_SEARCH_INCOMPLETE",
    args: { reason: "entries" },
  });
  await f.restart();
  assert.deepEqual(
    (await (await f.request(`/api/files/jobs/${job.id}`)).json()).issue,
    job.issue,
  );
});

test("public metadata operation validators reject extra options and multiple roots", async (t) => {
  const f = await applicationFixture(t);
  const { scopeId } = await (await f.request("/api/files/context")).json();
  for (const op of [
    operation(f.home, "search", { followLinks: true }),
    operation(f.home, "search", { query: "" }),
    operation(f.home, "search", { recursive: "yes" }),
    operation(f.home, "size", { hidden: false }),
    { ...operation(f.home), sources: [f.home, f.root] },
    { ...operation(f.home), target: f.root },
  ]) {
    const response = await f.request("/api/files/operations", {
      method: "POST",
      headers: { "X-File-Scope": scopeId },
      body: op,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "FILE_INVALID_OPERATION");
  }
  await f.application.sessions.save({
    id: "search-project",
    name: "fixture",
    tool: "shell",
    status: "exited",
    cwd: f.home,
    pipeline: { headless: true },
  });
  await fs.writeFile(path.join(f.home, "found.txt"), "ok");
  const base = "/api/sessions/search-project/files/explorer";
  const job = await start(f, operation(""), base);
  const entries = await (await f.request(`${base}/jobs/${job.id}/entries`)).json();
  assert.equal(entries.entries[0].path, "found.txt");
  assert.equal((await f.request(`/api/files/jobs/${job.id}`)).status, 404);
});

test("denied subdirectories preserve known results and an incomplete size", async (t) => {
  const f = await applicationFixture(t);
  await fs.mkdir(path.join(f.home, "denied"));
  await fs.writeFile(path.join(f.home, "known.txt"), "known");
  const opendir = fs.opendir;
  let denied = 0;
  t.mock.method(fs, "opendir", async (selected, ...args) => {
    if (selected === path.join(f.home, "denied")) {
      denied++;
      throw Object.assign(new Error("secret diagnostic"), { code: "EACCES" });
    }
    return opendir(selected, ...args);
  });
  const search = await start(f, operation(f.home));
  assert.equal(search.issue.args.reason, "access");
  assert.equal(
    (await (await f.request(`/api/files/jobs/${search.id}/entries`)).json()).entries
      .length,
    1,
  );
  const size = await start(f, operation(f.home, "size"));
  assert.equal(size.completedBytes, 5);
  assert.equal(size.totalBytes, null);
  assert.deepEqual(size.issue, {
    code: "FILE_SIZE_INCOMPLETE",
    args: { reason: "access" },
  });
  assert.equal(denied, 2);
  assert.equal(JSON.stringify(size).includes("secret"), false);
});

test("depth omissions and safe-integer size overflow remain explicit", async (t) => {
  const f = await applicationFixture(t, { files: { limits: { maxDepth: 1 } } });
  await fs.mkdir(path.join(f.home, "a", "b"), { recursive: true });
  await fs.writeFile(path.join(f.home, "a", "b", "deep.txt"), "deep");
  const deep = await start(f, operation(f.home));
  assert.equal(deep.issue.args.reason, "depth");
  await fs.writeFile(path.join(f.home, "huge"), "fixture");
  const lstat = fs.lstat;
  let observed = 0;
  t.mock.method(fs, "lstat", async (selected, ...args) => {
    const stat = await lstat(selected, ...args);
    if (selected === path.join(f.home, "huge")) {
      observed++;
      stat.size = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    }
    return stat;
  });
  const huge = await start(f, operation(path.join(f.home, "huge"), "size"));
  assert.equal(observed, 1);
  assert.equal(huge.totalBytes, null);
  assert.deepEqual(huge.issue, {
    code: "FILE_SIZE_INCOMPLETE",
    args: { reason: "overflow" },
  });
});

test("deterministic deadline stops traversal and cancellation owns its directory cleanup without leases", async (t) => {
  const { searchFiles } = await import("../../server/features/files/file-search.js");
  const { registerFileJobHandler } =
    await import("../../server/features/files/file-job-handlers.js");
  const f = await applicationFixture(t);
  await fs.writeFile(path.join(f.home, "known.txt"), "known");
  const services = f.application.files;
  let clock = 0;
  registerFileJobHandler(
    services.handlers,
    "search",
    (args) =>
      searchFiles({
        ...args,
        limits: services.limits,
        store: services.store,
        now: () => (clock++ === 0 ? 0 : services.limits.searchMs),
      }),
    { public: true, validate: () => true },
  );
  const timed = await start(f, operation(f.home));
  assert.equal(timed.completedEntries, 0);
  assert.equal(timed.issue.args.reason, "time");
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const opendir = fs.opendir;
  let closed = false;
  t.mock.method(fs, "opendir", async (...args) => {
    const dir = await opendir(...args);
    const close = dir.close.bind(dir);
    dir.close = async () => {
      closed = true;
      return close();
    };
    entered.resolve();
    await release.promise;
    return dir;
  });
  registerFileJobHandler(
    services.handlers,
    "search",
    (args) =>
      searchFiles({
        ...args,
        limits: services.limits,
        store: services.store,
      }),
    { public: true, validate: () => true },
  );
  const scope = await services.context();
  const job = await services.jobs.start(scope, operation(f.home));
  await entered.promise;
  // This snapshot must finish while the real handler waits for its directory.
  await f.application.mutationBarrier.snapshot(() => {});
  await services.jobs.cancel(scope, job.id);
  release.resolve();
  const cancelled = await waitForFileJob(f, job.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(closed, true);
});

test("store and scheduler keep transfer limits independent of metadata budgets", async (t) => {
  const { registerFileJobHandler } =
    await import("../../server/features/files/file-job-handlers.js");
  const f = await applicationFixture(t, {
    files: { limits: { jobEntries: 1, jobBytes: 1, searchEntries: 4, searchResults: 3 } },
  });
  const { store, jobs, handlers } = f.application.files;
  const scope = await f.application.files.context();
  for (const patch of [{ completedEntries: 2 }, { completedBytes: 2 }]) {
    registerFileJobHandler(handlers, "copy", ({ report }) => report(patch), {
      transfer: true,
    });
    const job = await jobs.start(scope, operation(f.home, "copy"));
    const failed = await waitForFileJob(f, job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.issue.code, "FILE_LIMIT_EXCEEDED");
    assert.throws(() => store.transition(job.id, "failed", "failed", patch), {
      code: "FILE_LIMIT_EXCEEDED",
    });
    store.putEntry(job.id, { id: "one" });
    assert.throws(() => store.putEntry(job.id, { id: "two" }), {
      code: "FILE_LIMIT_EXCEEDED",
    });
  }
});

test("a deadline during root stat never reports a complete size", async (t) => {
  const { measureFiles } = await import("../../server/features/files/file-search.js");
  const { registerFileJobHandler } =
    await import("../../server/features/files/file-job-handlers.js");
  const f = await applicationFixture(t);
  await fs.writeFile(path.join(f.home, "one"), "one");
  let clock = 0;
  const services = f.application.files;
  registerFileJobHandler(
    services.handlers,
    "size",
    (args) =>
      measureFiles({
        ...args,
        limits: services.limits,
        store: services.store,
        now: () => (clock++ === 0 ? 0 : services.limits.searchMs),
      }),
    { public: true, validate: () => true },
  );
  const job = await start(f, operation(path.join(f.home, "one"), "size"));
  assert.equal(job.totalBytes, null);
  assert.equal(job.issue.args.reason, "time");
});

test("metadata entry transport preserves unknown fields without inventing permission bits", async (t) => {
  const f = await applicationFixture(t);
  const services = f.application.files;
  const job = await start(f, operation(f.home));
  await f.application.mutationBarrier.run(() =>
    services.store.putEntry(job.id, {
      id: "unknown",
      path: "unknown",
      name: "unknown",
      type: "directory",
      size: null,
      readable: null,
      writable: null,
      revision: null,
      linkTarget: null,
      modifiedAt: null,
      privatePath: "secret recovery path",
      text: "private contents",
    }),
  );
  const response = await f.request(`/api/files/jobs/${job.id}/entries`);
  assert.equal(response.status, 200);
  const row = (await response.json()).entries[0];
  assert.equal(Object.hasOwn(row, "mode"), false);
  for (const field of [
    "size",
    "readable",
    "writable",
    "revision",
    "linkTarget",
    "modifiedAt",
  ])
    assert.equal(row[field], null);
  assert.equal(JSON.stringify(row).includes("private"), false);
  assert.equal(JSON.stringify(row).includes("secret"), false);
});
