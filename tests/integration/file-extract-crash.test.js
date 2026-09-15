import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileFixture } from "../helpers/file-explorer.js";
import { createFileServices } from "../../server/application/files.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";

for (const mode of ["private", "cancelled", "published", "tampered"])
  test(
    `actual SIGKILL extraction ${mode} reconciles only proven work`,
    { timeout: 15000 },
    async (t) => {
      const fixture = await fileFixture(t);
      const child = spawn(
        process.execPath,
        [
          new URL("../fixtures/file-extract-crash.mjs", import.meta.url).pathname,
          JSON.stringify({ fixture, mode: mode === "tampered" ? "published" : mode }),
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
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(result.signal, "SIGKILL", stderr);
      const before = JSON.parse(stdout),
        output = path.join(fixture.project, "tree/child");
      if (mode === "tampered") await fs.writeFile(output, "native changed output");
      await fs.unlink(path.join(fixture.home, "input.zip"));
      const files = createFileServices({
        config: { home: fixture.home, dataDir: fixture.dataDir },
        sessions: { get: async () => ({ id: "fixture", cwd: fixture.project }) },
        mutationBarrier: new MutationBarrier(),
      });
      try {
        await files.ready;
        const scope = await files.context(),
          job = files.jobs.get(scope, before.jobId);
        if (mode === "published") {
          assert.equal(job.status, "partially_completed");
          assert.equal(job.completedEntries, 2);
          assert.equal(await fs.readFile(output, "utf8"), "retained output");
          assert.deepEqual(await fs.readdir(fixture.project), ["tree"]);
        } else if (mode === "tampered") {
          assert.equal(job.status, "interrupted");
          assert.equal(job.completedEntries, 0);
          assert.equal(await fs.readFile(output, "utf8"), "native changed output");
          assert.ok(
            files.store
              .listPublications()
              .some((record) => record.phase === "interrupted"),
          );
        } else {
          assert.equal(job.status, mode === "cancelled" ? "cancelled" : "interrupted");
          assert.equal(job.completedEntries, 0);
          assert.deepEqual(await fs.readdir(fixture.project), []);
        }
      } finally {
        await files.close();
      }
    },
  );
