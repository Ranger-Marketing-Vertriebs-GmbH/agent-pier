import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileFixture } from "./file-explorer.js";
import { createFileServices } from "../../server/application/files.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";

export const uploadRequest = () => `${Date.now()}:${randomUUID()}`;
export async function uploadFixture(t, limits = {}) {
  const cleanup = [];
  const f = await fileFixture({ after: (fn) => cleanup.push(fn) });
  const barrier = new MutationBarrier();
  const options = {
    config: { home: f.home, dataDir: f.dataDir, files: { limits } },
    sessions: { get: async () => ({ id: "fixture", cwd: f.project }) },
    mutationBarrier: barrier,
  };
  let files = createFileServices(options);
  t.after(async () => {
    try {
      await files.close();
    } finally {
      for (const fn of cleanup.reverse()) await fn();
    }
  });
  await files.ready;
  assert.ok(files.uploads, "application composes the upload owner");
  Object.assign(f, files, { barrier, scope: f.globalScope });
  f.restart = async () => {
    await files.close();
    files = createFileServices(options);
    await files.ready;
    Object.assign(f, files);
  };
  f.create = (name, bytes, extra = {}) =>
    files.uploads.create(f.scope, {
      requestId: uploadRequest(),
      path: f.home,
      name,
      bytes,
      ...extra,
    });
  f.until = async (condition) => {
    for (let n = 0; n < 500; n++) {
      const result = await condition();
      if (result) return result;
      await delay(10);
    }
    assert.fail("owned file work did not reach the observed condition");
  };
  return f;
}
