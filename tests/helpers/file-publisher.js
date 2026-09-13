import fs from "node:fs/promises";
import path from "node:path";
import { fileFixture, seedFileJob } from "./file-explorer.js";
import { FileStore } from "../../server/features/files/file-store.js";
import { FileNative } from "../../server/features/files/file-native.js";
import { FilePublisher, fileRevision } from "../../server/features/files/file-publish.js";
import { PathLocks } from "../../server/features/files/file-locks.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";

async function fixture(t, intercept) {
  const f = await fileFixture(t);
  f.store = new FileStore({ dataDir: f.dataDir });
  f.native = new FileNative();
  if (intercept) {
    const run = f.native.run.bind(f.native);
    f.native.run = (op, args) => intercept(op, args, run, f);
  }
  f.locks = new PathLocks();
  f.barrier = new MutationBarrier();
  f.publisher = new FilePublisher({ ...f, barrier: f.barrier });
  f.jobId = seedFileJob(f.store, f.globalScope).id;
  f.target = path.join(f.home, "keep.txt");
  t.after(async () => {
    try {
      await f.publisher.close();
    } finally {
      await f.native.close();
      f.store.close();
    }
  });
  f.stage = () => f.publisher.stage(f.globalScope, f.target, { jobId: f.jobId });
  f.revision = async () => {
    const handle = await fs.open(f.target, "r");
    try {
      return await fileRevision(handle);
    } finally {
      await handle.close();
    }
  };
  return f;
}

export { fixture };
