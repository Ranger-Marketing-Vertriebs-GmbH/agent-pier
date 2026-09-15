import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  filenameFileSystem,
  filenameParent,
  encryptedEmptyDirectory,
} from "../helpers/file-platform.js";
import { uploadFixture } from "../helpers/file-uploads.js";
import {
  extractionZip,
  extractOperation,
  resolveExtract,
} from "../helpers/file-extract.js";

const required = process.env.AGENTPIER_FILE_FS_MATRIX === "1";
for (const sensitive of [true, false])
  test(
    `actual ${process.platform === "darwin" ? "APFS volume" : "ext4 directory"} ${sensitive ? "sensitive" : "casefold"} extraction proof`,
    {
      skip: required
        ? false
        : "Requires AGENTPIER_FILE_FS_MATRIX=1 and owned mount tooling; no filesystem support evidence from this skip.",
      timeout: 180000,
    },
    async (t) => {
      const cleanup = [];
      t.after(async () => {
        const failures = [];
        for (const close of cleanup.reverse())
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        if (failures.length)
          throw new AggregateError(failures, "Native fixture cleanup failed");
      });
      const hooks = {
        after: (close) => cleanup.push(close),
        diagnostic: (value) => t.diagnostic(value),
      };
      const volume = await filenameFileSystem(hooks, { caseSensitive: sensitive });
      const f = await uploadFixture(hooks),
        source = path.join(f.home, "input.zip");
      const target = await filenameParent(volume, "target", !sensitive);
      const before = await fs.stat(target);
      // Independent exclusive-create oracle in the actual selected parent.
      await fs.writeFile(path.join(target, "A"), "oracle", { flag: "wx" });
      if (sensitive) {
        await fs.writeFile(path.join(target, "a"), "oracle", { flag: "wx" });
        await fs.unlink(path.join(target, "a"));
      } else
        await assert.rejects(
          fs.writeFile(path.join(target, "a"), "alias", { flag: "wx" }),
          { code: "EEXIST" },
        );
      await fs.unlink(path.join(target, "A"));
      await fs.writeFile(
        source,
        extractionZip([
          { name: "A", bytes: "upper" },
          { name: "a", bytes: "lower" },
        ]),
      );
      let job = await f.jobs.start(f.scope, extractOperation(source, target));
      let result = await f.jobs.join(f.scope, job.id);
      assert.equal(
        result.status,
        sensitive ? "completed" : "failed",
        JSON.stringify(result),
      );
      if (!sensitive) assert.equal(result.issue.code, "FILE_ARCHIVE_ALIAS");
      assert.deepEqual((await fs.readdir(target)).sort(), sensitive ? ["A", "a"] : []);
      assert.equal((await fs.stat(target)).ino, before.ino);
      // Existing merge-parent policy is observed separately, including ext4 mixed flags.
      const merge = path.join(target, "merge");
      await fs.mkdir(merge);
      await fs.writeFile(
        source,
        extractionZip([{ name: "merge/unique", bytes: "merged" }]),
      );
      const mergeBefore = await fs.stat(merge);
      job = await f.jobs.start(f.scope, extractOperation(source, target));
      await resolveExtract(f, job, "merge");
      result = await f.jobs.join(f.scope, job.id);
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal((await fs.stat(merge)).ino, mergeBefore.ino);
      assert.equal(await fs.readFile(path.join(merge, "unique"), "utf8"), "merged");
      for (const pair of [
        ["é", "e\u0301"],
        ["Straße", "STRASSE"],
      ]) {
        const location = await filenameParent(volume, `unicode-${pair[0]}`, !sensitive);
        await fs.writeFile(path.join(location, pair[0]), "oracle", { flag: "wx" });
        let alias = false;
        try {
          await fs.writeFile(path.join(location, pair[1]), "oracle", { flag: "wx" });
        } catch (error) {
          assert.equal(error.code, "EEXIST");
          alias = true;
        }
        await fs.unlink(path.join(location, pair[0]));
        if (!alias) await fs.unlink(path.join(location, pair[1]));
        // Names inside the exact retained subtree must agree with this independent oracle.
        await fs.writeFile(
          source,
          extractionZip(pair.map((name) => ({ name: `subtree/${name}`, bytes: name }))),
        );
        job = await f.jobs.start(f.scope, extractOperation(source, location));
        result = await f.jobs.join(f.scope, job.id);
        assert.equal(
          result.status,
          alias ? "failed" : "completed",
          JSON.stringify({ pair, result }),
        );
        if (alias) {
          assert.equal(result.issue.code, "FILE_ARCHIVE_ALIAS");
          assert.deepEqual(await fs.readdir(location), []);
        } else
          assert.deepEqual(
            (await fs.readdir(path.join(location, "subtree"))).sort(),
            [...pair].sort(),
          );
      }
      if (process.platform === "linux") {
        const plain = await filenameParent(volume, "plain", false);
        const folded = await filenameParent(volume, "folded", true);
        const identities = await Promise.all(
          [plain, folded].map((folder) => fs.stat(folder)),
        );
        assert.equal(identities[0].dev, identities[1].dev);
        await fs.writeFile(
          source,
          extractionZip(["plain/A", "plain/a", "folded/A", "folded/a"]),
        );
        job = await f.jobs.start(f.scope, extractOperation(source, volume.directory));
        await resolveExtract(f, job, "merge", true);
        result = await f.jobs.join(f.scope, job.id);
        assert.equal(result.issue.code, "FILE_ARCHIVE_ALIAS", JSON.stringify(result));
        assert.deepEqual(await fs.readdir(plain), []);
        assert.deepEqual(await fs.readdir(folded), []);
        const encrypted = await filenameParent(volume, "encrypted", false);
        await encryptedEmptyDirectory(encrypted);
        await fs.writeFile(source, extractionZip(["unavailable"]));
        job = await f.jobs.start(f.scope, extractOperation(source, encrypted));
        result = await f.jobs.join(f.scope, job.id);
        assert.equal(
          result.issue.code,
          "FILE_EXTRACT_UNSUPPORTED",
          JSON.stringify(result),
        );
        assert.deepEqual(await fs.readdir(encrypted), []);
      }
      t.diagnostic(
        JSON.stringify({
          filesystem: process.platform === "darwin" ? "apfs" : "ext4",
          sensitive,
          device: volume.device,
          statDev: volume.identity,
        }),
      );
    },
  );
