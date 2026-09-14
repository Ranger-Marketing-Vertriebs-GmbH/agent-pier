import fs from "node:fs/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { createFileServices } from "../../server/application/files.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";
import { extractionZip, extractOperation } from "../helpers/file-extract.js";

const { fixture, mode } = JSON.parse(process.argv[2]);
const files = createFileServices({
  config: { home: fixture.home, dataDir: fixture.dataDir },
  sessions: { get: async () => ({ id: "fixture", cwd: fixture.project }) },
  mutationBarrier: new MutationBarrier(),
});
await files.ready;
const scope = await files.context(),
  source = path.join(fixture.home, "input.zip");
await fs.writeFile(
  source,
  extractionZip([{ name: "tree/child", bytes: "retained output" }]),
);
let job;
const crash = () => {
  writeSync(
    1,
    JSON.stringify({ jobId: job.id, status: files.jobs.get(scope, job.id).status }),
  );
  process.kill(process.pid, "SIGKILL");
};
if (mode === "published") {
  const run = files.publisher.native.run.bind(files.publisher.native);
  files.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    if (op === "renameNoReplace" && args.newName === "tree") crash();
    return result;
  };
} else {
  files.publisher.resumeExtract = async () => {
    if (mode === "cancelled") await files.jobs.cancel(scope, job.id);
    crash();
  };
}
job = await files.jobs.start(scope, extractOperation(source, fixture.project));
await files.jobs.join(scope, job.id);
throw Error("Fixture did not reach its crash boundary");
