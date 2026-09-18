import test from "node:test";
import assert from "node:assert/strict";
import { ArtifactService } from "../../server/features/artifacts/artifact-service.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";
test("an exclusive backup between outer mutation and artifact read cannot invert locks", async () => {
  const barrier = new MutationBarrier();
  const service = Object.assign(Object.create(ArtifactService.prototype), {
    barrier,
    queue: Promise.resolve(),
    closed: false,
  });
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const order = [];
  const mutation = barrier.run(async () => {
    entered();
    await gate;
    await service.serial(() => order.push("publish"));
  });
  await started;
  const backup = barrier.snapshot(() => order.push("backup"));
  const read = service.serial(() => order.push("read"));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  let timer;
  try {
    await Promise.race([
      Promise.all([mutation, backup, read]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("lock inversion")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(order, ["publish", "backup", "read"]);
});
