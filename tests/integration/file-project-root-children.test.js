import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";
import { resolveFile, entryRevision } from "../../server/features/files/file-paths.js";

async function entry(root, name, directory, bytes) {
  const target = path.join(root, name);
  if (directory) await fs.mkdir(target, { recursive: true });
  await fs.writeFile(directory ? path.join(target, "child.txt") : target, bytes);
  return fs.lstat(target, { bigint: true });
}
const contents = (root, name, directory) =>
  fs.readFile(path.join(root, name, ...(directory ? ["child.txt"] : [])), "utf8");

for (const kind of ["create", "copy", "move", "rename"])
  for (const directory of [false, true])
    test(`project-root ${kind} ${directory ? "directory" : "file"} Keep both preserves occupied alternates and exact result identity`, async (t) => {
      const f = await uploadFixture(t),
        scope = f.projectScope,
        name = directory ? "tree" : "a.txt",
        alternate = directory ? "tree (2)" : "a (2).txt",
        output = directory ? "tree (3)" : "a (3).txt",
        source = kind === "rename" ? `source-${name}` : `dir/${name}`;
      await fs.mkdir(path.join(f.project, "dir"));
      const occupied = await entry(f.project, name, directory, "ORIGINAL"),
        second = await entry(f.project, alternate, directory, "SECOND");
      const sourceStat =
        kind === "create" ? null : await entry(f.project, source, directory, "SOURCE");
      const selected =
        sourceStat && (await resolveFile(scope, source, { followLeaf: false }));
      const operation = {
        requestId: uploadRequest(),
        kind: kind === "create" ? `create_${directory ? "directory" : "file"}` : kind,
        sources: kind === "create" ? [] : [source],
        target: kind === "rename" ? null : "",
        name: ["create", "rename"].includes(kind) ? name : null,
        options:
          kind === "rename"
            ? {
                revisions: {
                  [source]: entryRevision(selected.stat, selected.linkIdentity),
                },
              }
            : {},
      };
      const started = await f.jobs.start(scope, operation);
      const waiting = await f.until(() => {
        const job = f.jobs.get(scope, started.id);
        return (job.conflict || ["failed", "completed"].includes(job.status)) && job;
      });
      assert.ok(waiting.conflict, JSON.stringify(waiting));
      await f.jobs.resolve(scope, started.id, {
        conflictId: waiting.conflict.id,
        decision: "keep_both",
        applyToRemaining: false,
      });
      const finished = await f.jobs.join(scope, started.id);
      assert.equal(finished.status, "completed", JSON.stringify(finished));
      assert.equal(await contents(f.project, name, directory), "ORIGINAL");
      assert.equal(await contents(f.project, alternate, directory), "SECOND");
      assert.equal(
        (await fs.lstat(path.join(f.project, name), { bigint: true })).ino,
        occupied.ino,
      );
      assert.equal(
        (await fs.lstat(path.join(f.project, alternate), { bigint: true })).ino,
        second.ino,
      );
      const published = await fs.lstat(path.join(f.project, output), { bigint: true });
      assert.equal(published.isDirectory(), directory);
      if (kind !== "create" || !directory)
        assert.equal(
          await contents(f.project, output, directory),
          kind === "create" ? "" : "SOURCE",
        );
      else assert.deepEqual(await fs.readdir(path.join(f.project, output)), []);
      if (["move", "rename"].includes(kind)) {
        assert.equal(published.ino, sourceStat.ino);
        await assert.rejects(fs.lstat(path.join(f.project, source)), { code: "ENOENT" });
      } else if (kind === "copy") {
        assert.notEqual(published.ino, sourceStat.ino);
        assert.equal(await contents(f.project, source, directory), "SOURCE");
      }
      const rows = f.jobs.entries(scope, started.id).entries;
      assert.ok(rows.length > 0);
      assert.ok(
        rows.every((row) => row.path === output || row.path === `${output}/child.txt`),
      );
      if (["copy", "move"].includes(kind)) {
        assert.equal(rows.length, directory ? 2 : 1);
        assert.ok(rows.every((row) => row.outputPublished === true));
        assert.ok(rows.every((row) => row.sourceRemoved === (kind === "move")));
      }
    });
