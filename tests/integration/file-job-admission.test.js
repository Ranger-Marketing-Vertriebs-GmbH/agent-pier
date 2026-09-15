import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setImmediate as tick } from "node:timers/promises";
import { fileFixture } from "../helpers/file-explorer.js";
import { FileStore } from "../../server/features/files/file-store.js";
import { FileJobs } from "../../server/features/files/file-jobs.js";
import { PathLocks } from "../../server/features/files/file-locks.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";
import { readFileLimits } from "../../server/features/files/file-limits.js";
import { makeFileScope } from "../../server/features/files/file-scope.js";

const execute = promisify(execFile);
const operation = () => ({
  requestId: `${Date.now()}:${randomUUID()}`,
  kind: "copy",
  sources: [],
  target: null,
  name: null,
  options: {},
});

for (const changed of ["cwd", "readOnly"]) {
  test(`admission rechecks ${changed} after a queued snapshot`, async (t) => {
    const f = await fileFixture(t);
    const initial = f.projectScope;
    const updated = await makeFileScope({
      home: f.home,
      session: {
        id: "fixture",
        cwd: changed === "cwd" ? f.home : f.project,
        pipeline: { headless: changed === "readOnly" },
      },
    });
    let current = initial;
    let calls = 0;
    const barrier = new MutationBarrier();
    const jobs = new FileJobs({
      store: new FileStore({ dataDir: f.dataDir }),
      locks: new PathLocks(),
      barrier,
      limits: readFileLimits(),
      handlers: new Map([
        [
          "copy",
          async () => {
            calls++;
          },
        ],
      ]),
      context: async () => current,
    });
    t.after(() => jobs.close());
    let snapshot, job;
    await barrier.run(async () => {
      snapshot = barrier.detached(() =>
        barrier.snapshot(() => {
          current = updated;
        }),
      );
      job = await jobs.start(initial, operation());
    });
    await snapshot;
    for (let i = 0; i < 200; i++) {
      if (["completed", "failed"].includes(jobs.get(initial, job.id).status)) break;
      await tick();
    }
    assert.equal(calls, 0, "handler must not enter with obsolete authority");
    assert.equal(jobs.get(initial, job.id).status, "failed");
    assert.equal(jobs.get(initial, job.id).issue.code, "FILE_INVALID_SCOPE");
  });
}

test("cancellation before conflict publication has an owned rejection under strict Node policy", async (t) => {
  const f = await fileFixture(t);
  // The parent owns the temporary directory even when a pre-fix child crashes.
  // No rejection listener is installed: an unowned rejection must fail this child.
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { setImmediate as tick } from "node:timers/promises";
    import { FileStore } from "./server/features/files/file-store.js";
    import { FileJobs } from "./server/features/files/file-jobs.js";
    import { PathLocks } from "./server/features/files/file-locks.js";
    import { MutationBarrier } from "./server/application/mutation-barrier.js";
    import { readFileLimits } from "./server/features/files/file-limits.js";
    const scope = ${JSON.stringify(f.globalScope)};
    const barrier = new MutationBarrier();
    const entered = Promise.withResolvers();
    const begin = Promise.withResolvers();
    const submitted = Promise.withResolvers();
    let observedAbort = false;
    const jobs = new FileJobs({
      store: new FileStore({dataDir:${JSON.stringify(f.dataDir)}}),
      locks: new PathLocks(), barrier, limits: readFileLimits(),
      handlers: new Map([["size", async ({conflict}) => {
        entered.resolve();
        await begin.promise;
        const decision = conflict({type:"exists",choices:["skip","cancel"]});
        submitted.resolve();
        try { await decision; }
        catch (error) { observedAbort = error.name === "AbortError"; throw error; }
      }]]),
    });
    const job = await jobs.start(scope, {
      requestId: Date.now()+":"+randomUUID(), kind:"size",sources:[],target:null,name:null,options:{},
    });
    await entered.promise;
    let snapshot;
    await barrier.run(async () => {
      snapshot = barrier.detached(() => barrier.snapshot(() => {}));
      begin.resolve();
      await submitted.promise;
      await jobs.cancel(scope, job.id);
      await tick();
    });
    await snapshot;
    for (let i=0;i<200 && jobs.get(scope,job.id).status!=="cancelled";i++) await tick();
    assert.equal(jobs.get(scope,job.id).status,"cancelled");
    assert.equal(observedAbort,true,"owned handler must observe cancellation");
    await jobs.close();
  `;
  await execute(
    process.execPath,
    ["--unhandled-rejections=strict", "--input-type=module", "-e", source],
    {
      cwd: new URL("../../", import.meta.url),
      timeout: 10000,
    },
  );
});
