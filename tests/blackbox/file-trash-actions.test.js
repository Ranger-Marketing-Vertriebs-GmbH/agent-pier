import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { waitForFileJob } from "../helpers/file-explorer.js";

async function submit(f, kind, sources, target = null, options = {}) {
  const context = await (await f.request("/api/files/context")).json();
  const response = await f.request("/api/files/operations", {
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
  assert.equal(response.status, 202, await response.clone().text());
  return response.json();
}
async function decision(f, job, choice) {
  const context = await (await f.request("/api/files/context")).json();
  return f.request(`/api/files/jobs/${job.id}/resolve`, {
    method: "POST",
    headers: { "X-File-Scope": context.scopeId },
    body: {
      conflictId: job.conflict.id,
      decision: choice,
      applyToRemaining: false,
    },
  });
}
async function captured(f, type = "file") {
  const original = path.join(f.home, "report.txt");
  if (type === "directory") await fs.mkdir(original);
  else await fs.writeFile(original, "saved");
  await waitForFileJob(f, (await submit(f, "trash", [original])).id);
  const [entry] = (await (await f.request("/api/files/trash")).json()).entries;
  return { original, entry };
}
test("HTTP restore Keep both publishes a sibling and typed stable outcome", async (t) => {
  const f = await applicationFixture(t);
  const { original, entry } = await captured(f);
  await fs.writeFile(original, "occupied");
  const job = await waitForFileJob(
    f,
    (await submit(f, "restore", [entry.id], original)).id,
    { states: ["waiting_for_conflict"] },
  );
  assert.equal(job.conflict.sourceType, "file");
  assert.equal(job.conflict.targetType, "file");
  assert.ok(job.conflict.choices.includes("keep_both"));
  assert.equal((await decision(f, job, "keep_both")).status, 200);
  assert.equal((await waitForFileJob(f, job.id)).status, "completed");
  assert.equal(await fs.readFile(original, "utf8"), "occupied");
  assert.equal(await fs.readFile(path.join(f.home, "report (2).txt"), "utf8"), "saved");
  const rows = (await (await f.request(`/api/files/jobs/${job.id}/entries`)).json())
    .entries;
  assert.equal(rows[0].source, entry.id);
  assert.equal(rows[0].status, "completed");
  assert.equal(rows[0].path, path.join(f.home, "report (2).txt"));
});
test("HTTP restore rejects decisions after private payload revision changes", async (t) => {
  const f = await applicationFixture(t);
  const { original, entry } = await captured(f);
  await fs.writeFile(original, "occupied");
  const job = await waitForFileJob(
    f,
    (await submit(f, "restore", [entry.id], original)).id,
    { states: ["waiting_for_conflict"] },
  );
  const record = f.application.files.store.getTrash(entry.id);
  await fs.writeFile(record.location.file, "changed private payload");
  assert.equal((await decision(f, job, "replace")).status, 409);
  assert.equal(await fs.readFile(original, "utf8"), "occupied");
});
test("directory restore never permits replacement, even with a direct target revision", async (t) => {
  const f = await applicationFixture(t);
  const { original, entry } = await captured(f, "directory");
  await fs.mkdir(original);
  const job = await waitForFileJob(
    f,
    (await submit(f, "restore", [entry.id], original)).id,
    { states: ["waiting_for_conflict"] },
  );
  assert.deepEqual(job.conflict.choices, ["keep_both", "skip", "cancel"]);
  assert.equal((await decision(f, job, "replace")).status, 409);
  const metadata = await (
    await f.request(`/api/files/metadata?path=${encodeURIComponent(original)}`)
  ).json();
  const direct = await submit(f, "restore", [entry.id], original, {
    expectedRevision: metadata.revision,
  });
  assert.equal((await waitForFileJob(f, direct.id)).status, "failed");
  assert.equal((await fs.stat(original)).isDirectory(), true);
});

test("mixed restore types reject direct overwrite and disclose only usable choices", async (t) => {
  const f = await applicationFixture(t);
  const { original, entry } = await captured(f);
  await fs.mkdir(original);
  const job = await waitForFileJob(
    f,
    (await submit(f, "restore", [entry.id], original)).id,
    { states: ["waiting_for_conflict"] },
  );
  assert.equal(job.conflict.sourceType, "file");
  assert.equal(job.conflict.targetType, "directory");
  assert.deepEqual(job.conflict.choices, ["keep_both", "skip", "cancel"]);
  const metadata = await (
    await f.request(`/api/files/metadata?path=${encodeURIComponent(original)}`)
  ).json();
  const direct = await submit(f, "restore", [entry.id], original, {
    expectedRevision: metadata.revision,
  });
  assert.equal((await waitForFileJob(f, direct.id)).status, "failed");
  assert.equal((await decision(f, job, "keep_both")).status, 200);
  assert.equal((await waitForFileJob(f, job.id)).status, "completed");
  assert.equal((await fs.stat(original)).isDirectory(), true);
});

test("Keep both never overwrites a competing late creation or retries adopted payload", async (t) => {
  const f = await applicationFixture(t);
  const { original, entry } = await captured(f);
  await fs.writeFile(original, "occupied");
  const job = await waitForFileJob(
    f,
    (await submit(f, "restore", [entry.id], original)).id,
    { states: ["waiting_for_conflict"] },
  );
  const publisher = f.application.files.publisher;
  const publish = publisher.publish.bind(publisher);
  let publications = 0;
  const sibling = path.join(f.home, "report (2).txt");
  publisher.publish = async (...args) => {
    publications++;
    await fs.writeFile(sibling, "racing creator", { flag: "wx" });
    return publish(...args);
  };
  assert.equal((await decision(f, job, "keep_both")).status, 200);
  assert.equal((await waitForFileJob(f, job.id)).status, "failed");
  assert.equal(publications, 1);
  assert.equal(await fs.readFile(sibling, "utf8"), "racing creator");
  assert.equal(await fs.readFile(original, "utf8"), "occupied");
  const remaining = (await (await f.request("/api/files/trash")).json()).entries;
  assert.equal(remaining[0].availability, "pending");
  assert.equal(JSON.stringify(remaining).includes("payload"), false);
  const rows = (await (await f.request(`/api/files/jobs/${job.id}/entries`)).json())
    .entries;
  assert.equal(rows[0].status, "failed");
  assert.notEqual(rows[0].sourceRemoved, true);
});

test("restore rechecks the private revision at actual adoption", async (t) => {
  const f = await applicationFixture(t);
  const { original, entry } = await captured(f);
  const publisher = f.application.files.publisher;
  const stage = publisher.stage.bind(publisher);
  publisher.stage = async (...args) => {
    const value = await stage(...args),
      adopt = value.adoptEntry.bind(value);
    value.adoptEntry = async (...input) => {
      const record = f.application.files.store.getTrash(entry.id);
      await fs.writeFile(record.location.file, "changed immediately before adoption");
      return adopt(...input);
    };
    return value;
  };
  const job = await submit(f, "restore", [entry.id], original);
  assert.equal((await waitForFileJob(f, job.id)).status, "failed");
  await assert.rejects(fs.stat(original), { code: "ENOENT" });
});

test("purge partial failure publishes stable per-ID evidence and does not infer remaining removals", async (t) => {
  const f = await applicationFixture(t);
  const first = await captured(f);
  await fs.writeFile(first.original, "second");
  await waitForFileJob(f, (await submit(f, "trash", [first.original])).id);
  const entries = (await (await f.request("/api/files/trash")).json()).entries;
  const trash = f.application.files.trash,
    purge = trash.purge.bind(trash);
  let count = 0;
  trash.purge = async (...args) => {
    if (++count === 2)
      await fs.writeFile(
        f.application.files.store.getTrash(args[1]).location.file,
        "changed after whole-batch preflight",
      );
    return purge(...args);
  };
  const job = await submit(
    f,
    "purge",
    entries.map((entry) => entry.id),
    null,
    { confirmation: entries.map(({ id, revision }) => ({ id, revision })) },
  );
  const finished = await waitForFileJob(f, job.id);
  assert.equal(finished.status, "partially_completed");
  const rows = (await (await f.request(`/api/files/jobs/${job.id}/entries`)).json())
    .entries;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, entries[0].id);
  assert.equal(rows[0].sourceRemoved, true);
  assert.equal(rows[1].source, entries[1].id);
  assert.equal(rows[1].status, "failed");
  assert.notEqual(rows[1].sourceRemoved, true);
});

test("cancellation after purge removal preserves the completed row despite a cancelled progress report", async (t) => {
  const f = await applicationFixture(t);
  const { entry } = await captured(f);
  const trash = f.application.files.trash,
    purge = trash.purge.bind(trash);
  trash.purge = async (scope, id, options) => {
    await purge(scope, id, options);
    await f.application.files.jobs.cancel(scope, options.jobId);
  };
  const job = await submit(f, "purge", [entry.id], null, {
    confirmation: [{ id: entry.id, revision: entry.revision }],
  });
  assert.equal((await waitForFileJob(f, job.id)).status, "cancelled");
  const rows = (await (await f.request(`/api/files/jobs/${job.id}/entries`)).json())
    .entries;
  assert.equal(rows[0].sourceRemoved, true);
  assert.equal(rows[0].status, "completed");
  assert.deepEqual((await (await f.request("/api/files/trash")).json()).entries, []);
});
