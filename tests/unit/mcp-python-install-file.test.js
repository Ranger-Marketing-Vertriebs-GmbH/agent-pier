import test from "node:test";
import assert from "node:assert/strict";
import { installFile } from "../../server/features/mcp-packages/python-install-file.js";

const digest = (char) => char.repeat(64);
const file = (filename, char = "a") => ({
  filename,
  sha256: digest(char),
  packagetype: filename.endsWith(".whl") ? "bdist_wheel" : "sdist",
});
const mac = { platform: "darwin", arch: "arm64" };
const linux = { platform: "linux", arch: "x64" };
const wheel = (tags) => file(`srv_x-1.0-${tags}.whl`);
const pure = wheel("py3-none-any");
const macWheel = wheel("cp314-cp314-macosx_11_0_arm64");
const linuxWheel = wheel("cp314-cp314-manylinux_2_17_x86_64.manylinux2014_x86_64");
const sdist = file("srv_x-1.0.tar.gz", "f");
const pick = (files, host) => installFile(files, host)?.filename ?? null;

test("the chosen file comes with its PyPI digest", () => {
  assert.deepEqual(installFile([file("srv_x-1.0-py3-none-any.whl", "b")], linux), {
    filename: "srv_x-1.0-py3-none-any.whl",
    sha256: digest("b"),
  });
});

test("a matching platform wheel ranks before the pure wheel, as uv ranks them", () => {
  assert.equal(pick([pure, macWheel, linuxWheel, sdist], mac), macWheel.filename);
  assert.equal(pick([pure, macWheel, linuxWheel, sdist], linux), linuxWheel.filename);
  assert.equal(pick([macWheel, pure, sdist], linux), pure.filename);
});

test("abi cp314 beats abi3, abi3 beats none; the newer abi3 build wins", () => {
  const abi3 = wheel("cp39-abi3-macosx_11_0_arm64");
  const newerAbi3 = wheel("cp312-abi3-macosx_11_0_arm64");
  const none = wheel("py3-none-macosx_11_0_arm64");
  assert.equal(pick([abi3, macWheel], mac), macWheel.filename);
  assert.equal(pick([none, abi3, newerAbi3], mac), newerAbi3.filename);
  assert.equal(pick([pure, none], mac), none.filename);
  assert.equal(pick([wheel("cp315-abi3-macosx_11_0_arm64"), sdist], mac), sdist.filename);
});

test("among equal tags the newest platform version wins; arch before universal2", () => {
  const older = wheel("cp314-cp314-manylinux_2_17_x86_64");
  const newer = wheel("cp314-cp314-manylinux_2_28_x86_64");
  const generic = wheel("cp314-cp314-linux_x86_64");
  assert.equal(pick([generic, older, newer], linux), newer.filename);
  const universal = wheel("cp314-cp314-macosx_11_0_universal2");
  const newMac = wheel("cp314-cp314-macosx_14_0_arm64");
  assert.equal(pick([universal, macWheel], mac), macWheel.filename);
  assert.equal(pick([macWheel, newMac], mac), newMac.filename);
});

test("pure wheels for any Python 3 up to 3.14 fit; newer or Python 2 ones do not", () => {
  assert.equal(
    pick([wheel("py310-none-any"), sdist], linux),
    "srv_x-1.0-py310-none-any.whl",
  );
  assert.equal(
    pick([wheel("py2.py3-none-any")], linux),
    "srv_x-1.0-py2.py3-none-any.whl",
  );
  assert.equal(pick([wheel("py310-none-any"), pure], linux), pure.filename);
  assert.equal(pick([wheel("py315-none-any"), sdist], linux), sdist.filename);
  assert.equal(pick([wheel("py2-none-any"), sdist], linux), sdist.filename);
});

test("without a fitting wheel the sdist is the file; musllinux never fits glibc", () => {
  const musl = wheel("cp314-cp314-musllinux_1_2_x86_64");
  const arm = wheel("cp314-cp314-manylinux_2_17_aarch64");
  assert.equal(pick([musl, arm, macWheel, sdist], linux), sdist.filename);
  assert.equal(pick([musl, linuxWheel], linux), linuxWheel.filename);
  assert.equal(
    pick([wheel("cp311-cp311-macosx_11_0_arm64"), sdist], mac),
    sdist.filename,
  );
  assert.equal(pick([macWheel], linux), null);
  assert.equal(pick([], mac), null);
});
