import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileFixture } from "../helpers/file-explorer.js";
import { uploadFixture } from "../helpers/file-uploads.js";
import { archiveOperation, artifactBytes, zipEntries } from "../helpers/file-archives.js";
import { createFileServices } from "../../server/application/files.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";

for (const mode of [
  "missing-source",
  "changed-omissions",
  "stale-scope",
  "no-validator",
  "cancelled-intent",
  "valid",
  "valid-completion",
])
  test(
    `actual SIGKILL ${mode} preserves only validated non-cancelled completion`,
    { timeout: 15000 },
    async (t) => {
      const fixture = await fileFixture(t);
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../fixtures/file-zip-crash.mjs", import.meta.url)),
          JSON.stringify({ fixture, mode }),
        ],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 10000, killSignal: "SIGKILL" },
      );
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      const exited = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(exited.signal, "SIGKILL", stderr);
      const before = JSON.parse(stdout.trim());
      const files = createFileServices({
        config: { home: fixture.home, dataDir: fixture.dataDir },
        sessions: { get: async () => ({ id: "fixture", cwd: fixture.project }) },
        mutationBarrier: new MutationBarrier(),
      });
      try {
        await files.ready;
        const scope = await files.context(),
          after = files.jobs.get(scope, before.jobId);
        t.diagnostic(JSON.stringify({ mode, before, after: after.status }));
        if (mode.startsWith("valid")) {
          assert.ok(before.validationCalls >= 1);
          assert.equal(before.validated, true);
          assert.equal(after.status, "completed");
          assert.equal(
            (await zipEntries(await artifactBytes({ ...files, scope }, before.jobId)))
              .get("source")
              .toString(),
            "source before crash",
          );
        } else {
          if (mode === "cancelled-intent") {
            assert.ok(
              before.validationCalls >= 1,
              "cancellation is after actual final source validation",
            );
            assert.equal(before.status, "cancelling");
            assert.equal(after.status, "cancelled");
            const record = files.store.listPublications()[0];
            assert.throws(() => files.store.archives.complete(record), {
              code: "FILE_ARCHIVE_PENDING",
            });
            assert.equal(files.store.archives.finish(before.jobId), false);
          } else {
            assert.equal(after.status, "interrupted");
            assert.equal(before.validated, false);
          }
          await assert.rejects(artifactBytes({ ...files, scope }, before.jobId), {
            code: "FILE_ARCHIVE_PENDING",
          });
        }
      } finally {
        await files.close();
      }
    },
  );

for (const type of ["file", "directory"])
  test(`global ${type} through symlink/.. preserves selected native bytes and spelling`, async (t) => {
    const f = await uploadFixture(t),
      lexical = path.join(f.home, "lexical"),
      real = path.join(f.home, "real");
    await fs.mkdir(lexical);
    await fs.mkdir(path.join(real, "child"), { recursive: true });
    await fs.symlink(path.join(real, "child"), path.join(lexical, "alias"));
    if (type === "directory") {
      await fs.mkdir(path.join(real, "source"));
      await fs.mkdir(path.join(lexical, "source"));
    }
    const suffix = type === "directory" ? "/file" : "";
    await fs.writeFile(real + "/source" + suffix, "selected native bytes");
    await fs.writeFile(lexical + "/source" + suffix, "wrong lexical bytes");
    const selected = lexical + "/alias/../source";
    const expected = await fs.readFile(selected + suffix);
    const job = await f.jobs.start(f.scope, archiveOperation([selected]));
    assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
    assert.deepEqual(
      (await zipEntries(await artifactBytes(f, job.id))).get("source" + suffix),
      expected,
    );
    assert.ok(
      f.jobs
        .entries(f.scope, job.id)
        .entries.every((row) => row.source.startsWith(selected)),
    );
    const project = await f.jobs.start(
      f.projectScope,
      archiveOperation(["../real/source"]),
    );
    assert.equal(
      (await f.jobs.join(f.projectScope, project.id)).issue.code,
      "FILE_OUTSIDE_SCOPE",
    );
  });

test("public archive symlink conflict reports its actual type without offering replacement", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "source"),
    link = path.join(f.home, "out.zip");
  await fs.writeFile(source, "source");
  await fs.symlink(source, link);
  const job = await f.jobs.start(
    f.scope,
    archiveOperation([source], {
      target: f.home,
      name: "out.zip",
      options: { output: "file" },
    }),
  );
  const conflict = await f.until(() => f.jobs.get(f.scope, job.id).conflict);
  assert.equal(conflict.targetType, "symlink");
  assert.equal(conflict.choices.includes("replace"), false);
  assert.match(conflict.revision, /^e1:/);
  await f.jobs.cancel(f.scope, job.id);
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "cancelled");
  assert.ok((await fs.lstat(link)).isSymbolicLink());
});
