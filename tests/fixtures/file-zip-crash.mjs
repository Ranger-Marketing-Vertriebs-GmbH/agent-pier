import fs from "node:fs/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { createFileServices } from "../../server/application/files.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";
import { archiveOperation } from "../helpers/file-archives.js";

const { fixture, mode } = JSON.parse(process.argv[2]);
const files = createFileServices({
  config: { home: fixture.home, dataDir: fixture.dataDir },
  sessions: { get: async () => ({ id: "fixture", cwd: fixture.project }) },
  mutationBarrier: new MutationBarrier(),
});
await files.ready;
const scope = await files.context(),
  source = path.join(fixture.project, "source");
await fs.writeFile(source, "source before crash");
let validationCalls = 0;
function crash(error) {
  const record = files.store.listPublications()[0];
  writeSync(
    1,
    JSON.stringify({
      jobId: record.jobId,
      validationCalls,
      status: files.jobs.get(scope, record.jobId).status,
      hasProof: Boolean(record.document.archiveProof),
      validated: Boolean(record.document.archiveValidated),
      phase: record.phase,
      issue: error?.code,
    }) + "\n",
  );
  process.kill(process.pid, "SIGKILL");
}
const checkpoint = files.publisher.checkpointArchive.bind(files.publisher);
files.publisher.checkpointArchive = async (stage, proof, options) => {
  if (!proof) return checkpoint(stage, proof, options);
  if (mode === "missing-source") await fs.unlink(source);
  if (mode === "changed-omissions")
    await fs.symlink(source, path.join(fixture.project, "late-link"));
  if (mode === "stale-scope") files.jobs.context = () => files.context("fixture");
  const checked =
    mode === "no-validator"
      ? {}
      : {
          ...options,
          validate: async () => {
            validationCalls++;
            await options.validate();
          },
        };
  try {
    await checkpoint(stage, proof, checked);
  } catch (error) {
    crash(error);
  }
  if (mode === "cancelled-intent") return;
  if (mode === "valid-completion")
    files.store.archives.complete(files.store.listPublications()[0]);
  if (mode.startsWith("valid")) await fs.unlink(source);
  crash();
};
if (mode === "cancelled-intent") {
  const finish = files.publisher.finishArchive.bind(files.publisher);
  files.publisher.finishArchive = (stage, options) =>
    finish(stage, {
      ...options,
      validate: async () => {
        await options.validate();
        const record = files.store.listPublications()[0];
        await files.jobs.cancel(scope, record.jobId);
        crash();
      },
    });
}
const job = await files.jobs.start(
  scope,
  archiveOperation([mode === "changed-omissions" ? fixture.project : source]),
);
await files.jobs.join(scope, job.id);
throw new Error("The archive did not reach its exact crash seam");
