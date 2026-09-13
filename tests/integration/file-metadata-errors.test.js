import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fchmodSync } from "node:fs";
import path from "node:path";
import koffi from "koffi";
import { fileFixture } from "../helpers/file-explorer.js";
import { attachAttributes, observeAttributes } from "../helpers/file-native-metadata.js";
import { darwinMetadataFunctions } from "../../server/features/files/file-native-darwin.js";
import { linuxMetadataFunctions } from "../../server/features/files/file-native-linux.js";
import * as engine from "../../server/features/files/file-native-metadata.js";

async function fixture(t) {
  assert.equal(
    typeof engine.metadataOperations,
    "function",
    "metadata operation error boundary is implemented",
  );
  const f = await fileFixture(t);
  const source = await fs.open(path.join(f.project, "source"), "wx+");
  const target = await fs.open(path.join(f.project, "target"), "wx+");
  t.after(async () => {
    await source.close();
    await target.close();
  });
  await source.writeFile("source");
  await target.writeFile("target");
  await source.chmod(0o750);
  attachAttributes(
    source.fd,
    "user.agentpier-unsupported",
    Buffer.from("private metadata value"),
  );
  const library = koffi.load(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null,
  );
  const functions =
    process.platform === "darwin"
      ? darwinMetadataFunctions(library, engine.checkedNative, koffi)
      : linuxMetadataFunctions(library, engine.checkedNative);
  // A controlled complete-observation adapter reaches strict syscall error branches.
  // Real Linux capability is separately tested as unproven; this is not a privilege claim.
  functions.completeness = { complete: true };
  return { ...f, source, target, functions };
}

test("unsupported namespace is a bounded copy warning and a strict preservation failure", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  f.functions.set = () => {
    attempts++;
    throw Object.assign(new Error("sensitive native detail"), { code: "ENOTSUP" });
  };
  const operation = engine.metadataOperations(f.functions, process.platform);
  assert.throws(
    () =>
      operation.copy(f.source.fd, f.target.fd, {
        strictOwnership: true,
        preserveTimes: true,
      }),
    { code: "ENOTSUP" },
  );
  assert.equal(attempts, 1);
  const result = operation.copy(f.source.fd, f.target.fd, {
    strictOwnership: false,
    preserveTimes: true,
  });
  assert.deepEqual(result, {
    warnings: [{ code: "FILE_METADATA_UNSUPPORTED", args: {} }],
  });
  assert.equal((await f.target.stat()).mode & 0o777, 0o750);
  assert.equal(
    observeAttributes(f.source.fd)[0].value.toString(),
    "private metadata value",
  );
  assert.equal(await fs.readFile(path.join(f.project, "target"), "utf8"), "target");
});

test("an unsupported attribute warning does not hide unrelated mode corruption", async (t) => {
  const f = await fixture(t);
  f.functions.set = () => {
    throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
  };
  f.functions.copyAcl = () => fchmodSync(f.target.fd, 0o700);
  assert.throws(
    () =>
      engine
        .metadataOperations(f.functions, process.platform)
        .copy(f.source.fd, f.target.fd, { strictOwnership: false, preserveTimes: false }),
    { code: "FILE_METADATA_MISMATCH" },
  );
});

test("native errno is captured immediately and maps EACCES", () => {
  koffi.errno(13);
  assert.throws(() => engine.checkedNative(-1), { code: "EACCES" });
});

test("metadata snapshots reject a source changed during native attribute reads", async (t) => {
  const f = await fixture(t);
  const get = f.functions.get;
  let changed = false;
  f.functions.get = (...args) => {
    const result = get(...args);
    if (args[2] && !changed) {
      changed = true;
      fchmodSync(f.source.fd, 0o700);
    }
    return result;
  };
  assert.throws(
    () => engine.metadataOperations(f.functions, process.platform).read(f.source.fd),
    { code: "FILE_PATH_CHANGED" },
  );
  assert.equal(changed, true);
});

test("unproven namespace completeness stops strict copies before target mutation but permits an explicit ordinary-copy warning", async (t) => {
  const f = await fixture(t);
  f.functions.completeness = { complete: false, reason: "namespace_visibility" };
  const operation = engine.metadataOperations(f.functions, process.platform);
  const before = await f.target.stat({ bigint: true });
  assert.throws(
    () =>
      operation.copy(f.source.fd, f.target.fd, {
        strictOwnership: true,
        preserveTimes: true,
      }),
    { code: "FILE_METADATA_UNSUPPORTED" },
  );
  assert.equal((await f.target.stat({ bigint: true })).ctimeNs, before.ctimeNs);
  assert.deepEqual(observeAttributes(f.target.fd), []);
  assert.deepEqual(operation.read(f.source.fd).completeness, {
    complete: false,
    reason: "namespace_visibility",
  });
  assert.deepEqual(
    operation.copy(f.source.fd, f.target.fd, {
      strictOwnership: false,
      preserveTimes: true,
    }),
    { warnings: [{ code: "FILE_METADATA_UNSUPPORTED", args: {} }] },
  );
  assert.deepEqual(observeAttributes(f.target.fd), observeAttributes(f.source.fd));
  assert.equal((await f.target.stat()).mode & 0o777, 0o750);
  assert.equal(await fs.readFile(path.join(f.project, "target"), "utf8"), "target");
});
