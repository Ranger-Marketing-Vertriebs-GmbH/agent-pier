import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { waitForFileJob } from "../helpers/file-explorer.js";

async function operation(f, kind, sources, { target = null, options = {} } = {}) {
  const context = await (await f.request("/api/files/context")).json();
  return f.request("/api/files/operations", {
    method: "POST",
    headers: { "X-File-Scope": context.scopeId },
    body: {
      requestId: `${Date.now()}:${randomUUID()}`,
      kind,
      sources,
      target,
      name: null,
      options,
    },
  });
}

test("HTTP trash exposes bounded revisions and purge consumes the entire confirmed selection", async (t) => {
  const f = await applicationFixture(t);
  const source = path.join(f.home, "trash-me");
  await fs.writeFile(source, "private bytes");
  const submitted = await operation(f, "trash", [source]);
  assert.equal(submitted.status, 202, await submitted.clone().text());
  assert.equal(
    (await waitForFileJob(f, (await submitted.json()).id)).status,
    "completed",
  );
  const listed = await f.request("/api/files/trash");
  assert.equal(listed.status, 200);
  const body = await listed.json();
  const [entry] = body.entries;
  assert.equal(entry.originalPath, source);
  assert.equal(entry.availability, "recoverable");
  assert.match(entry.revision, /^t1:/);
  assert.equal(JSON.stringify(body).includes("payload"), false);
  assert.equal(JSON.stringify(body).includes("private bytes"), false);
  const missing = await operation(f, "purge", [entry.id], { options: {} });
  assert.equal(missing.status, 400);
  const extra = await operation(f, "purge", [entry.id], {
    options: {
      confirmation: [
        { id: entry.id, revision: entry.revision },
        { id: "extra", revision: entry.revision },
      ],
    },
  });
  assert.equal(extra.status, 400);
  const purge = await operation(f, "purge", [entry.id], {
    options: { confirmation: [{ id: entry.id, revision: entry.revision }] },
  });
  assert.equal(purge.status, 202, await purge.clone().text());
  assert.equal((await waitForFileJob(f, (await purge.json()).id)).status, "completed");
  assert.deepEqual((await (await f.request("/api/files/trash")).json()).entries, []);
});

test("HTTP restore resolve rejects a changed target before accepting the decision", async (t) => {
  const f = await applicationFixture(t);
  const source = path.join(f.home, "restore-me");
  await fs.writeFile(source, "original");
  const submitted = await operation(f, "trash", [source]);
  assert.equal(submitted.status, 202);
  await waitForFileJob(f, (await submitted.json()).id);
  const [entry] = (await (await f.request("/api/files/trash")).json()).entries;
  await fs.writeFile(source, "occupied");
  const restore = await operation(f, "restore", [entry.id], { target: source });
  assert.equal(restore.status, 202);
  const job = await waitForFileJob(f, (await restore.json()).id, {
    states: ["waiting_for_conflict", "failed"],
  });
  assert.equal(job.status, "waiting_for_conflict");
  await fs.writeFile(source, "external changed bytes");
  const context = await (await f.request("/api/files/context")).json();
  const response = await f.request(`/api/files/jobs/${job.id}/resolve`, {
    method: "POST",
    headers: { "X-File-Scope": context.scopeId },
    body: { conflictId: job.conflict.id, decision: "replace", applyToRemaining: false },
  });
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(await fs.readFile(source, "utf8"), "external changed bytes");
  assert.equal((await (await f.request("/api/files/trash")).json()).entries.length, 1);
});

for (const cancelFirst of [false, true])
  test(`HTTP conflict validation releases snapshot leases and drains during ${cancelFirst ? "cancel then " : ""}close`, async (t) => {
    const f = await applicationFixture(t);
    const source = path.join(f.home, "waiting");
    await fs.writeFile(source, "original");
    const submitted = await operation(f, "trash", [source]);
    await waitForFileJob(f, (await submitted.json()).id);
    const [entry] = (await (await f.request("/api/files/trash")).json()).entries;
    await fs.writeFile(source, "occupied");
    const submittedRestore = await operation(f, "restore", [entry.id], {
      target: source,
    });
    const job = await waitForFileJob(f, (await submittedRestore.json()).id, {
      states: ["waiting_for_conflict"],
    });
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const publisher = f.application.files.publisher,
      original = publisher.assertExpected.bind(publisher);
    publisher.assertExpected = async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    };
    const context = await (await f.request("/api/files/context")).json();
    const headers = { "X-File-Scope": context.scopeId };
    const resolving = f.request(`/api/files/jobs/${job.id}/resolve`, {
      method: "POST",
      headers,
      body: { conflictId: job.conflict.id, decision: "replace", applyToRemaining: false },
    });
    await entered.promise;
    const snapshot = f.application.mutationBarrier.snapshot(() => "snapshot passed");
    let closing;
    try {
      assert.equal(
        await Promise.race([
          snapshot,
          new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
        ]),
        "snapshot passed",
      );
      if (cancelFirst)
        assert.equal(
          (
            await f.request(`/api/files/jobs/${job.id}/cancel`, {
              method: "POST",
              headers,
              body: {},
            })
          ).status,
          200,
        );
      let closed = false;
      closing = f.application.files.jobs.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(closed, false);
    } finally {
      release.resolve();
      await snapshot;
      await closing;
    }
    assert.equal((await resolving).status, 409);
    assert.equal(await fs.readFile(source, "utf8"), "occupied");
  });

test("trash HTTP projections retain project and owner authorization", async (t) => {
  const f = await applicationFixture(t);
  const project = path.join(f.home, "project");
  await fs.mkdir(project);
  const inside = path.join(project, "inside"),
    outside = path.join(f.home, "outside");
  for (const name of [inside, outside]) {
    await fs.writeFile(name, "private");
    const submitted = await operation(f, "trash", [name]);
    await waitForFileJob(f, (await submitted.json()).id);
  }
  await f.application.sessions.save({
    id: "trash-project",
    name: "fixture",
    tool: "shell",
    status: "exited",
    cwd: project,
    pipeline: { headless: true },
  });
  const listed = await f.request("/api/sessions/trash-project/files/explorer/trash");
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].originalPath, "inside");
  assert.equal(
    (
      await f.request("/api/files/trash", {
        headers: { authorization: "Bearer fixture-machine-token" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/api/files/trash", { origin: "https://foreign.example" })).status,
    403,
  );
});

test("canceling a restore conflict produces a cancelled job and retains both versions", async (t) => {
  const f = await applicationFixture(t);
  const source = path.join(f.home, "cancel-restore");
  await fs.writeFile(source, "saved");
  const submitted = await operation(f, "trash", [source]);
  await waitForFileJob(f, (await submitted.json()).id);
  const [entry] = (await (await f.request("/api/files/trash")).json()).entries;
  await fs.writeFile(source, "occupied");
  const submittedRestore = await operation(f, "restore", [entry.id], { target: source });
  const job = await waitForFileJob(f, (await submittedRestore.json()).id, {
    states: ["waiting_for_conflict"],
  });
  const context = await (await f.request("/api/files/context")).json();
  const response = await f.request(`/api/files/jobs/${job.id}/resolve`, {
    method: "POST",
    headers: { "X-File-Scope": context.scopeId },
    body: { conflictId: job.conflict.id, decision: "cancel", applyToRemaining: false },
  });
  assert.equal(response.status, 200);
  assert.equal((await waitForFileJob(f, job.id)).status, "cancelled");
  assert.equal(await fs.readFile(source, "utf8"), "occupied");
  assert.equal(
    (await (await f.request("/api/files/trash")).json()).entries[0].availability,
    "recoverable",
  );
});
