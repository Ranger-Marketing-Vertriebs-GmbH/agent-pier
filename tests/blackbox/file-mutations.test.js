import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { waitForFileJob } from "../helpers/file-explorer.js";

async function submit(f, overrides = {}, base = "/api/files") {
  const context = await (await f.request(`${base}/context`)).json();
  return f.request(`${base}/operations`, {
    method: "POST",
    headers: { "X-File-Scope": context.scopeId },
    body: {
      requestId: `${Date.now()}:${randomUUID()}`,
      kind: "create_file",
      sources: [],
      target: f.home,
      name: "keep.txt",
      options: {},
      ...overrides,
    },
  });
}
async function resolve(f, job, decision) {
  const context = await (await f.request("/api/files/context")).json();
  return f.request(`/api/files/jobs/${job.id}/resolve`, {
    method: "POST",
    headers: { "X-File-Scope": context.scopeId },
    body: { conflictId: job.conflict.id, decision, applyToRemaining: false },
  });
}

test("creating an existing name becomes a conflict without modifying it", async (t) => {
  const f = await applicationFixture(t);
  await fs.writeFile(path.join(f.home, "keep.txt"), "keep");
  const response = await submit(f);
  assert.equal(response.status, 202, await response.clone().text());
  const job = await waitForFileJob(f, (await response.json()).id, {
    states: ["waiting_for_conflict", "failed"],
  });
  assert.equal(job.status, "waiting_for_conflict");
  assert.equal(await fs.readFile(path.join(f.home, "keep.txt"), "utf8"), "keep");
  assert.match(job.conflict.targetRevision, /^e1:/);
  assert.equal((await resolve(f, job, "cancel")).status, 200);
  assert.equal((await waitForFileJob(f, job.id)).status, "cancelled");
});

test("create validates names/options synchronously and duplicate IDs create exactly once", async (t) => {
  const f = await applicationFixture(t);
  for (const name of ["", ".", "..", "a/b", "bad\nname", "ä".repeat(128)])
    assert.equal((await submit(f, { name })).status, 400);
  assert.equal((await submit(f, { options: { mode: 0o777 } })).status, 400);
  const requestId = `${Date.now()}:${randomUUID()}`;
  const first = await submit(f, { requestId, name: "Grüße 🌻.txt" });
  assert.equal(first.status, 202);
  const job = await first.json();
  assert.equal((await waitForFileJob(f, job.id)).status, "completed");
  const second = await submit(f, { requestId, name: "Grüße 🌻.txt" });
  assert.equal((await second.json()).id, job.id);
  assert.equal((await submit(f, { requestId, name: "other.txt" })).status, 409);
  assert.equal(
    (await fs.stat(path.join(f.home, "Grüße 🌻.txt"))).mode & 0o777,
    0o600 & ~process.umask(),
  );
  const directory = await submit(f, { kind: "create_directory", name: "Ordner" });
  assert.equal(
    (await waitForFileJob(f, (await directory.json()).id)).status,
    "completed",
  );
  assert.equal(
    (await fs.stat(path.join(f.home, "Ordner"))).mode & 0o777,
    0o700 & ~process.umask(),
  );
});

test("replacement keeps old bytes in trash and rejects stale conflict decisions", async (t) => {
  const f = await applicationFixture(t);
  const target = path.join(f.home, "keep.txt");
  await fs.writeFile(target, "keep");
  const response = await submit(f);
  assert.equal(response.status, 202);
  const job = await waitForFileJob(f, (await response.json()).id, {
    states: ["waiting_for_conflict"],
  });
  await fs.writeFile(target, "changed");
  assert.equal((await resolve(f, job, "replace")).status, 409);
  assert.equal(await fs.readFile(target, "utf8"), "changed");
  const second = await submit(f);
  const conflict = await waitForFileJob(f, (await second.json()).id, {
    states: ["waiting_for_conflict"],
  });
  assert.equal((await resolve(f, conflict, "replace")).status, 200);
  assert.equal((await waitForFileJob(f, conflict.id)).status, "completed");
  assert.equal(await fs.readFile(target, "utf8"), "");
  const [entry] = (await (await f.request("/api/files/trash")).json()).entries;
  assert.equal(entry.reason, "replaced");
  assert.equal(
    await fs.readFile(
      path.join(f.dataDir, "files", "trash", entry.id, "payload"),
      "utf8",
    ),
    "changed",
  );
});

test("readonly sessions reject all new mutation kinds", async (t) => {
  const f = await applicationFixture(t);
  await f.application.sessions.save({
    id: "readonly-files",
    name: "fixture",
    tool: "shell",
    status: "exited",
    cwd: f.home,
    pipeline: { headless: true },
  });
  for (const kind of ["create_file", "create_directory", "rename"])
    assert.equal(
      (
        await submit(
          f,
          {
            kind,
            target: kind === "rename" ? null : "",
            sources: kind === "rename" ? ["old"] : [],
            options:
              kind === "rename" ? { revisions: { old: `e1:${"a".repeat(64)}` } } : {},
          },
          "/api/sessions/readonly-files/files/explorer",
        )
      ).status,
      403,
    );
});

async function renameOperation(f, source, name = "keep.txt") {
  const metadata = await (
    await f.request(`/api/files/metadata?path=${encodeURIComponent(source)}`)
  ).json();
  return {
    kind: "rename",
    sources: [source],
    target: null,
    name,
    options: { revisions: { [source]: metadata.revision } },
  };
}

test("HTTP rename validates source preconditions and rejects changed sources at conflict resolution", async (t) => {
  const f = await applicationFixture(t);
  const source = path.join(f.home, "source.txt"),
    target = path.join(f.home, "keep.txt");
  await fs.writeFile(source, "source");
  await fs.writeFile(target, "keep");
  const operation = await renameOperation(f, source);
  for (const options of [
    {},
    { revisions: {} },
    { revisions: { [source]: [operation.options.revisions[source]] } },
    { revisions: operation.options.revisions, overwrite: true },
  ])
    assert.equal((await submit(f, { ...operation, options })).status, 400);
  assert.equal((await submit(f, { ...operation, target: f.home })).status, 400);
  const response = await submit(f, operation);
  assert.equal(response.status, 202);
  const job = await waitForFileJob(f, (await response.json()).id, {
    states: ["waiting_for_conflict"],
  });
  assert.equal(job.conflict.source, source);
  assert.match(job.conflict.sourceRevision, /^e1:/);
  assert.match(job.conflict.targetRevision, /^e1:/);
  await fs.writeFile(source, "changed source");
  assert.equal((await resolve(f, job, "replace")).status, 409);
  assert.equal(await fs.readFile(source, "utf8"), "changed source");
  assert.equal(await fs.readFile(target, "utf8"), "keep");
});

test("HTTP rename keep-both reports the actual result and repeated request IDs do not rename twice", async (t) => {
  const f = await applicationFixture(t);
  const source = path.join(f.home, "source.txt"),
    target = path.join(f.home, "keep.txt");
  await fs.writeFile(source, "source");
  await fs.writeFile(target, "keep");
  const operation = {
    ...(await renameOperation(f, source)),
    requestId: `${Date.now()}:${randomUUID()}`,
  };
  const response = await submit(f, operation);
  const job = await waitForFileJob(f, (await response.json()).id, {
    states: ["waiting_for_conflict"],
  });
  assert.equal((await resolve(f, job, "keep_both")).status, 200);
  assert.equal((await waitForFileJob(f, job.id)).status, "completed");
  const entries = await (await f.request(`/api/files/jobs/${job.id}/entries`)).json();
  assert.equal(entries.entries[0].path, path.join(f.home, "keep (2).txt"));
  assert.equal(await fs.readFile(path.join(f.home, "keep (2).txt"), "utf8"), "source");
  assert.equal(await fs.readFile(target, "utf8"), "keep");
  assert.equal((await (await submit(f, operation)).json()).id, job.id);
  assert.equal((await fs.readdir(f.home)).includes("keep (3).txt"), false);
});
