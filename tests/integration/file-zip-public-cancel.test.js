import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture } from "../helpers/file-uploads.js";
import { archiveOperation, artifactBytes, zipEntries } from "../helpers/file-archives.js";
import { FileNative } from "../../server/features/files/file-native.js";

for (const replacement of [false, true])
  for (const checkpointFailure of [false, true])
    test(
      `public ${replacement ? "exchange" : "no-replace"} cancellation retains output and ${checkpointFailure ? "recovers its checkpoint" : "finishes accounting"}`,
      { timeout: 15000 },
      async (t) => {
        const f = await uploadFixture(t),
          source = path.join(f.home, "source"),
          target = path.join(f.home, "public.zip");
        const payload = "new archive source",
          old = "old replaced file";
        await fs.writeFile(source, payload);
        if (replacement) await fs.writeFile(target, old);
        const prior = replacement ? await fs.stat(target) : null;
        const gate = Promise.withResolvers(),
          entered = Promise.withResolvers();
        const run = f.publisher.native.run.bind(f.publisher.native);
        let published = 0,
          paused = false;
        f.publisher.native.run = async (op, args) => {
          const value = await run(op, args);
          if (
            ["exchange", "renameNoReplace"].includes(op) &&
            args.newName === "public.zip"
          )
            published++;
          if (published && !paused && op === "read") {
            paused = true;
            assert.equal(f.barrier.hasLease(), false);
            entered.resolve();
            await gate.promise;
          }
          return value;
        };
        let checkpointFailed = false;
        const complete = f.store.archives.complete.bind(f.store.archives);
        f.store.archives.complete = (...args) => {
          if (checkpointFailure && !checkpointFailed) {
            checkpointFailed = true;
            throw new Error("injected durable checkpoint failure");
          }
          return complete(...args);
        };
        const operation = archiveOperation([source], {
          target: f.home,
          name: "public.zip",
          options: { output: "file" },
        });
        const job = await f.jobs.start(f.scope, operation);
        try {
          if (replacement) {
            const conflict = await f.until(() => f.jobs.get(f.scope, job.id).conflict);
            await f.jobs.resolve(f.scope, job.id, {
              conflictId: conflict.id,
              decision: "replace",
              applyToRemaining: false,
            });
          }
          await entered.promise;
          assert.equal(published, 1);
          assert.equal((await f.jobs.cancel(f.scope, job.id)).status, "cancelling");
        } finally {
          gate.resolve();
        }
        assert.equal((await f.jobs.join(f.scope, job.id)).status, "cancelled");
        assert.equal(paused, true);
        const installed = await fs.stat(target),
          bytes = await fs.readFile(target);
        assert.equal((await zipEntries(bytes)).get("source").toString(), payload);
        assert.equal(published, 1);
        const assertAccounted = () => {
          const archive = f.store.archives.get(job.id),
            record = f.store.getPublication(archive.publicationId);
          assert.equal(f.jobs.get(f.scope, job.id).status, "cancelled");
          assert.equal(archive.published, true);
          assert.notEqual(archive.completed, true);
          assert.equal(record.document.archiveCompleted, true);
          assert.equal(record.phase, "resolved");
          const row = f.jobs.entries(f.scope, job.id).entries[0];
          assert.equal(row.status, "completed");
          assert.equal(row.outputPublished, true);
          assert.equal(f.jobs.get(f.scope, job.id).completedEntries, 1);
          assert.equal(
            f.jobs.get(f.scope, job.id).completedBytes,
            Buffer.byteLength(payload),
          );
        };
        if (checkpointFailure) {
          assert.equal(checkpointFailed, true);
          assert.notEqual(f.store.archives.get(job.id).published, true);
          assert.equal(f.store.listPublications()[0].phase, "interrupted");
        } else assertAccounted();
        const beforeTrash = (await f.trash.list(f.scope)).entries;
        assert.equal(beforeTrash.length, replacement && !checkpointFailure ? 1 : 0);
        if (beforeTrash.length) {
          assert.equal(beforeTrash[0].availability, "recoverable");
          assert.match(beforeTrash[0].revision, /^t1:/);
        }
        await fs.unlink(source);
        const nativeRun = FileNative.prototype.run;
        let replayPublications = 0;
        FileNative.prototype.run = function (op, args) {
          if (
            op === "exchange" ||
            (op === "renameNoReplace" && args.newName === "public.zip")
          )
            replayPublications++;
          return nativeRun.call(this, op, args);
        };
        try {
          await f.restart();
        } finally {
          FileNative.prototype.run = nativeRun;
        }
        assert.equal(replayPublications, 0);
        assertAccounted();
        for (let replay = 0; replay < 2; replay++) {
          const result = await f.jobs.start(f.scope, operation);
          assert.equal(result.id, job.id);
          assert.equal(result.status, "cancelled");
        }
        assert.equal((await fs.stat(target)).ino, installed.ino);
        assert.deepEqual(await fs.readFile(target), bytes);
        assert.equal(f.store.listPublications().length, 1);
        await assert.rejects(artifactBytes(f, job.id), { code: "FILE_NOT_FOUND" });
        const trash = (await f.trash.list(f.scope)).entries;
        assert.equal(trash.length, replacement ? 1 : 0);
        if (replacement) {
          const [entry] = trash;
          assert.equal(entry.id, f.store.archives.get(job.id).publicationId);
          assert.equal(entry.availability, "recoverable");
          assert.match(entry.revision, /^t1:/);
          if (beforeTrash.length) assert.equal(entry.id, beforeTrash[0].id);
          const restored = path.join(f.home, "restored.txt");
          const restore = await f.jobs.start(f.scope, {
            ...archiveOperation([entry.id]),
            kind: "restore",
            target: restored,
            options: { expectedRevision: null },
          });
          assert.equal((await f.jobs.join(f.scope, restore.id)).status, "completed");
          assert.equal(await fs.readFile(restored, "utf8"), old);
          assert.equal((await fs.stat(restored)).ino, prior.ino);
          assert.equal((await f.trash.list(f.scope)).entries.length, 0);
          assert.equal(f.jobs.get(f.scope, job.id).status, "cancelled");
          assert.deepEqual(await fs.readFile(target), bytes);
        }
      },
    );
