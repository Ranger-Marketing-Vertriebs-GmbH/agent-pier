import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import koffi from "koffi";
import { fileFixture } from "../helpers/file-explorer.js";
import { errnoChecked } from "../../server/features/files/file-native-errno.js";
import { writeFunctions } from "../../server/features/files/file-native-write.js";
import { darwinAbi } from "../../server/features/files/file-native-darwin.js";
import { linuxAbi } from "../../server/features/files/file-native-linux.js";

const { ENOENT, EAGAIN } = koffi.os.errno;

// V8 can run libc calls (a contended futex during garbage collection) while an
// error object is built; on Linux that leaves EAGAIN in the live errno. Model
// that by overwriting errno whenever an Error is constructed.
function withClobberingErrors(action) {
  const Original = globalThis.Error;
  const clobber = () => koffi.errno(EAGAIN);
  globalThis.Error = new Proxy(Original, {
    apply(target, self, args) {
      clobber();
      return Reflect.apply(target, self, args);
    },
    construct(target, args, newTarget) {
      clobber();
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    action();
  } catch (error) {
    return error;
  } finally {
    globalThis.Error = Original;
  }
  assert.fail("expected a native failure");
}

test("native failures report the errno of the failed call", () => {
  const failing = (value) => () => {
    koffi.errno(ENOENT);
    return value;
  };
  for (const value of [-1, null])
    assert.equal(
      withClobberingErrors(() => errnoChecked(failing(value), "failed")()).code,
      "ENOENT",
    );
  assert.equal(errnoChecked(() => 3, "failed")(), 3);
});

test("inspecting a missing name stays ENOENT while the error is built", async (t) => {
  const f = await fileFixture(t),
    abi = process.platform === "darwin" ? darwinAbi : linuxAbi;
  const fd = fs.openSync(f.home, "r");
  try {
    const run = writeFunctions(koffi.load(abi.library), abi, {
      lookup: () => ({ fd, directory: true }),
      keep() {},
      openComponent() {},
    });
    const error = withClobberingErrors(() =>
      run("inspect", { directory: 1, name: "missing" }),
    );
    assert.equal(error.code, "ENOENT");
  } finally {
    fs.closeSync(fd);
  }
});
