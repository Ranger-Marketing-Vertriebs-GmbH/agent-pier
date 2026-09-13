import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import koffi from "koffi";
import { fileFixture } from "../helpers/file-explorer.js";
import { writeFunctions } from "../../server/features/files/file-native-write.js";
import { darwinAbi } from "../../server/features/files/file-native-darwin.js";
import { linuxAbi } from "../../server/features/files/file-native-linux.js";

test("missing owned-link reader leaves unrelated native operations usable", async (t) => {
  const f = await fileFixture(t),
    abi = process.platform === "darwin" ? darwinAbi : linuxAbi;
  const library = koffi.load(abi.library);
  const file = path.join(f.home, "keep");
  fs.writeFileSync(file, "data");
  const fd = fs.openSync(file, "r");
  try {
    const run = writeFunctions(
      {
        func: (declaration) => {
          if (/freadlink|readlinkat/.test(declaration))
            throw Error("missing optional symbol");
          return library.func(declaration);
        },
      },
      abi,
      { lookup: () => ({ fd, link: true }), keep() {}, openComponent() {} },
    );
    assert.equal(run("stat", { handle: 1 }).size, 4n);
    assert.throws(() => run("readLink", { handle: 1 }), {
      code: "FILE_NATIVE_UNSUPPORTED",
    });
  } finally {
    fs.closeSync(fd);
  }
});

test("actual owned-link operation failure is not relabeled as missing capability", async (t) => {
  const f = await fileFixture(t),
    abi = process.platform === "darwin" ? darwinAbi : linuxAbi;
  const library = koffi.load(abi.library);
  const file = path.join(f.home, "regular");
  fs.writeFileSync(file, "data");
  const fd = fs.openSync(file, "r");
  try {
    const run = writeFunctions(library, abi, {
      lookup: () => ({ fd, link: true }),
      keep() {},
      openComponent() {},
    });
    assert.throws(
      () => run("readLink", { handle: 1 }),
      (error) => error.code === "EINVAL" || error.code === "ENOENT",
    );
  } finally {
    fs.closeSync(fd);
  }
});
