import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";
import { extractionZip, extractOperation } from "../helpers/file-extract.js";
import { fileProblem } from "../../server/features/files/file-errors.js";
import {
  failedRetry,
  failedMergedExtract,
  retrySettled,
} from "../helpers/file-retries.js";

for (const kind of [
  "extract",
  "copy",
  "move",
  "restore",
  "create_file",
  "create_directory",
  "archive",
])
  for (const boundary of ["before POST", "after queued prepare", "at target use"])
    test(`${kind} retry rejects replaced destination parent ${boundary}`, async (t) => {
      const f = await uploadFixture(t);
      const { job, target, parent } = await (kind === "extract"
        ? failedMergedExtract(f)
        : failedRetry(f, kind));
      const proposal = await f.retries.preview(f.scope, job.id);
      const retained = parent + "-retained";
      const replace = async () => {
        await fs.rename(parent, retained);
        await fs.mkdir(parent);
      };
      if (boundary === "before POST") {
        await replace();
        await assert.rejects(
          f.retries.start(f.scope, job.id, {
            requestId: uploadRequest(),
            reference: proposal.reference,
          }),
          { code: "FILE_RETRY_UNAVAILABLE" },
        );
      } else {
        if (boundary === "after queued prepare") {
          const prepare = f.jobs.prepareJob;
          f.jobs.prepareJob = async (...args) => {
            const prepared = await prepare(...args);
            if (prepared) await replace();
            return prepared;
          };
        } else {
          const method = kind === "move" ? "rename" : "stage";
          const actual = f.publisher[method].bind(f.publisher);
          let replaced = false;
          f.publisher[method] = async (...args) => {
            if (
              !replaced &&
              (kind !== "extract" || args[2]?.extract?.role === "output")
            ) {
              replaced = true;
              await replace();
            }
            return actual(...args);
          };
        }
        const child = await f.retries.start(f.scope, job.id, {
          requestId: uploadRequest(),
          reference: proposal.reference,
        });
        const final = await retrySettled(f, child);
        assert.equal(final.status, "failed");
        assert.ok(
          [
            "FILE_RETRY_UNAVAILABLE",
            "FILE_PATH_CHANGED",
            "FILE_CONFLICT_CHANGED",
          ].includes(final.issue?.code),
          final.issue?.code,
        );
      }
      await assert.rejects(fs.stat(target), { code: "ENOENT" });
      if (kind === "extract")
        assert.equal(await fs.readFile(path.join(retained, "a"), "utf8"), "first");
    });

test("retry target identity permits ordinary sibling changes and preserves completed extraction", async (t) => {
  const f = await uploadFixture(t),
    { job, parent, target } = await failedMergedExtract(f);
  const inode = (await fs.stat(path.join(parent, "a"))).ino;
  const proposal = await f.retries.preview(f.scope, job.id);
  await fs.writeFile(path.join(parent, "unrelated"), "sibling");
  assert.equal((await f.retries.preview(f.scope, job.id)).reference, proposal.reference);
  const child = await f.retries.start(f.scope, job.id, {
    requestId: uploadRequest(),
    reference: proposal.reference,
  });
  assert.equal((await retrySettled(f, child)).status, "completed");
  assert.equal((await fs.stat(path.join(parent, "a"))).ino, inode);
  assert.equal(await fs.readFile(target, "utf8"), "second");
});

for (const kind of ["restore", "rename", "archive"])
  test(`${kind} retry displays original provenance and its full intended destination`, async (t) => {
    const f = await uploadFixture(t),
      { job, target, source } = await failedRetry(f, kind);
    const proposal = await f.retries.preview(f.scope, job.id);
    assert.equal(proposal.entries[0].source, source);
    assert.equal(proposal.entries[0].path, target);
    await fs.writeFile(target, "new occupant");
    await assert.rejects(
      f.retries.start(f.scope, job.id, {
        requestId: uploadRequest(),
        reference: proposal.reference,
      }),
      { code: "FILE_RETRY_UNAVAILABLE" },
    );
    const fresh = await f.retries.preview(f.scope, job.id);
    const child = await f.retries.start(f.scope, job.id, {
      requestId: uploadRequest(),
      reference: fresh.reference,
    });
    await f.until(() => f.jobs.get(f.scope, child.id).conflict);
    const conflict = f.jobs.get(f.scope, child.id).conflict;
    assert.equal(conflict.target, target);
    await f.jobs.resolve(f.scope, child.id, {
      conflictId: conflict.id,
      decision: "keep_both",
      applyToRemaining: false,
    });
    assert.equal((await retrySettled(f, child)).status, "completed");
    assert.equal(await fs.readFile(target, "utf8"), "new occupant");
  });

test("rename retry detects a newly occupied destination after queued preparation", async (t) => {
  const f = await uploadFixture(t),
    { job, target, source } = await failedRetry(f, "rename");
  const proposal = await f.retries.preview(f.scope, job.id),
    prepare = f.jobs.prepareJob;
  f.jobs.prepareJob = async (...args) => {
    const value = await prepare(...args);
    if (value) await fs.writeFile(target, "new occupant");
    return value;
  };
  const child = await f.retries.start(f.scope, job.id, {
    requestId: uploadRequest(),
    reference: proposal.reference,
  });
  assert.equal((await retrySettled(f, child)).issue.code, "FILE_RETRY_UNAVAILABLE");
  assert.equal(await fs.readFile(source, "utf8"), "original bytes");
  assert.equal(await fs.readFile(target, "utf8"), "new occupant");
});

test("retry guard checks the opened native destination parent before any stage mutation", async (t) => {
  const f = await uploadFixture(t),
    { job, target, parent } = await failedRetry(f, "copy");
  const proposal = await f.retries.preview(f.scope, job.id),
    run = f.publisher.native.run.bind(f.publisher.native);
  let replaced = false;
  f.publisher.native.run = async (command, args) => {
    const value = await run(command, args);
    if (!replaced && command === "openRoot" && args.path === parent) {
      replaced = true;
      await fs.rename(parent, parent + "-retained");
      await fs.mkdir(parent);
    }
    return value;
  };
  const child = await f.retries.start(f.scope, job.id, {
    requestId: uploadRequest(),
    reference: proposal.reference,
  });
  assert.equal((await retrySettled(f, child)).issue.code, "FILE_RETRY_UNAVAILABLE");
  assert.equal(replaced, true);
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(parent + "-retained"), []);
});

test("extraction retry can create a wholly unfinished nested tree under its observed existing ancestor", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "nested.zip");
  await fs.writeFile(
    source,
    extractionZip([{ name: "new/deeper/file.txt", bytes: "nested bytes" }]),
  );
  const stage = f.publisher.stage.bind(f.publisher);
  f.publisher.stage = async (...args) => {
    if (args[2]?.extract?.role === "output") throw fileProblem("FILE_ACCESS_DENIED", 403);
    return stage(...args);
  };
  const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
  assert.equal((await retrySettled(f, job)).status, "failed");
  f.publisher.stage = stage;
  const proposal = await f.retries.preview(f.scope, job.id);
  const child = await f.retries.start(f.scope, job.id, {
    requestId: uploadRequest(),
    reference: proposal.reference,
  });
  const final = await retrySettled(f, child);
  assert.equal(final.status, "completed", JSON.stringify(final.issue));
  assert.equal(
    await fs.readFile(path.join(f.project, "new/deeper/file.txt"), "utf8"),
    "nested bytes",
  );
});

test("restore retry requests a fresh typed decision when an earlier alternate is occupied", async (t) => {
  const f = await uploadFixture(t),
    { job, target, source, parent } = await failedRetry(f, "restore");
  await fs.writeFile(target, "original occupant");
  const restore = f.trash.restore.bind(f.trash);
  let attempted;
  f.trash.restore = async (...args) => {
    attempted = args[2];
    throw fileProblem("FILE_ACCESS_DENIED", 403);
  };
  const proposal = await f.retries.preview(f.scope, job.id);
  const first = await f.retries.start(f.scope, job.id, {
    requestId: uploadRequest(),
    reference: proposal.reference,
  });
  await f.until(() => f.jobs.get(f.scope, first.id).conflict);
  await f.jobs.resolve(f.scope, first.id, {
    conflictId: f.jobs.get(f.scope, first.id).conflict.id,
    decision: "keep_both",
    applyToRemaining: false,
  });
  assert.equal((await retrySettled(f, first)).status, "failed");
  assert.equal(attempted, path.join(parent, "chosen (2).txt"));
  f.trash.restore = restore;
  await fs.writeFile(attempted, "new alternate occupant");
  const nextProposal = await f.retries.preview(f.scope, first.id);
  assert.deepEqual(
    nextProposal.entries.map((row) => [row.source, row.path]),
    [[source, target]],
  );
  const next = await f.retries.start(f.scope, first.id, {
    requestId: uploadRequest(),
    reference: nextProposal.reference,
  });
  await f.until(() => f.jobs.get(f.scope, next.id).conflict);
  const conflict = f.jobs.get(f.scope, next.id).conflict;
  assert.equal(conflict.target, target);
  assert.equal(conflict.choices.includes("merge"), false);
  await f.jobs.resolve(f.scope, next.id, {
    conflictId: conflict.id,
    decision: "keep_both",
    applyToRemaining: false,
  });
  assert.equal((await retrySettled(f, next)).status, "completed");
  assert.equal(
    await fs.readFile(path.join(parent, "chosen (3).txt"), "utf8"),
    "original bytes",
  );
  assert.equal(await fs.readFile(attempted, "utf8"), "new alternate occupant");
  assert.equal(f.jobs.get(f.scope, first.id).status, "failed");
});
