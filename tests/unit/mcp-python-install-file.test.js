import test from "node:test";
import assert from "node:assert/strict";
import { installFile } from "../../server/features/mcp-packages/python-install-file.js";

const digest = (char) => char.repeat(64);
const file = (filename, char) => ({
  filename,
  sha256: digest(char),
  packagetype: filename.endsWith(".whl") ? "bdist_wheel" : "sdist",
});
const mac = { platform: "darwin", arch: "arm64" };
const linux = { platform: "linux", arch: "x64" };
const pure = file("srv_x-1.0-py3-none-any.whl", "a");
const macWheel = file("srv_x-1.0-cp314-cp314-macosx_11_0_arm64.whl", "b");
const linuxWheel = file(
  "srv_x-1.0-cp314-cp314-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
  "c",
);
const abi3 = file("srv_x-1.0-cp39-abi3-macosx_10_9_universal2.whl", "d");
const oldPython = file("srv_x-1.0-cp311-cp311-macosx_11_0_arm64.whl", "e");
const sdist = file("srv_x-1.0.tar.gz", "f");
const pick = (files, host) => installFile(files, host)?.filename ?? null;

test("the pure wheel is the file the install uses, wherever it runs", () => {
  assert.deepEqual(installFile([macWheel, pure, sdist], linux), {
    filename: pure.filename,
    sha256: digest("a"),
  });
});

test("without a pure wheel the host's platform wheel for CPython 3.14 is used", () => {
  assert.equal(pick([macWheel, linuxWheel, sdist], mac), macWheel.filename);
  assert.equal(pick([macWheel, linuxWheel, sdist], linux), linuxWheel.filename);
  assert.equal(pick([oldPython, abi3, sdist], mac), abi3.filename);
  assert.equal(pick([oldPython, sdist], mac), sdist.filename);
});

test("an sdist is the file when no wheel fits; nothing when neither exists", () => {
  assert.equal(pick([sdist], linux), sdist.filename);
  assert.equal(pick([macWheel], linux), null);
  assert.equal(pick([], mac), null);
});
