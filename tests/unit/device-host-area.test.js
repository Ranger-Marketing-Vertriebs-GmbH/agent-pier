import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyIn, copyOut, locate } from "../../server/features/devices/host-area.js";

// The host side of a file that travels to or from a device (host-area.js): it stays
// inside the caller's own area, whatever links say.
const refused = (code) => (error) => error.code === code;
const outside = refused("DEVICE_PATH_OUTSIDE");
const missing = refused("DEVICE_FILE_NOT_FOUND");

// A folder with an area (the caller's working folder), a private folder of the
// server's and a secret outside both.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "device-area-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const area = path.join(root, "project");
  const priv = path.join(root, "private");
  const data = path.join(root, "data");
  for (const folder of [path.join(area, "build"), priv, data])
    fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(root, "secret.txt"), "the secret");
  fs.writeFileSync(path.join(area, "build", "app.apk"), "apk bytes");
  let count = 0;
  const target = () => path.join(priv, `copy-${++count}`);
  const read = (requested, options = {}) =>
    copyIn({ area, requested, target: target(), maxBytes: 1000, ...options });
  const write = (requested, content = "pulled", options = {}) => {
    const source = target();
    fs.writeFileSync(source, content);
    return copyOut({ area, requested, source, maxBytes: 1000, ...options });
  };
  return { root, area, priv, data, target, read, write };
}

test("a file of the area is copied, by a relative or an absolute path", async (t) => {
  const f = fixture(t);
  const target = f.target();
  assert.deepEqual(
    await copyIn({ area: f.area, requested: "build/app.apk", target, maxBytes: 1000 }),
    { bytes: 9, name: "app.apk" },
  );
  assert.equal(fs.readFileSync(target, "utf8"), "apk bytes");
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal((await f.read(path.join(f.area, "build", "app.apk"))).bytes, 9);
  // `..` that stays inside is a path like any other.
  assert.equal((await f.read("build/../build/./app.apk")).bytes, 9);
});

test("a path that leaves the area is refused: `..`, absolute, the area itself", async (t) => {
  const f = fixture(t);
  for (const requested of [
    "../secret.txt",
    "build/../../secret.txt",
    path.join(f.root, "secret.txt"),
    "/etc/hosts",
    ".",
    "",
    "a\0b",
    "x".repeat(5000),
  ])
    await assert.rejects(f.read(requested), outside, JSON.stringify(requested));
  await assert.rejects(f.read("build/missing.apk"), missing);
  await assert.rejects(f.read("build"), missing);
  // Nothing was left in the server's folder.
  assert.deepEqual(fs.readdirSync(f.priv), []);
});

test("a link out of the area is refused; a link inside it is followed", async (t) => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, "secret.txt"), path.join(f.area, "leak.apk"));
  fs.symlinkSync(f.root, path.join(f.area, "up"));
  fs.symlinkSync(path.join(f.area, "build"), path.join(f.area, "out"));
  fs.symlinkSync("app.apk", path.join(f.area, "build", "latest.apk"));
  await assert.rejects(f.read("leak.apk"), outside);
  await assert.rejects(f.read("up/secret.txt"), outside);
  assert.deepEqual(await f.read("out/app.apk"), { bytes: 9, name: "app.apk" });
  assert.deepEqual(await f.read("build/latest.apk"), { bytes: 9, name: "app.apk" });
  // A second name for a file may lead anywhere: a hard link is never read.
  fs.linkSync(path.join(f.root, "secret.txt"), path.join(f.area, "hard.apk"));
  await assert.rejects(f.read("hard.apk"), outside);
  // The area may itself be reached through a link.
  const alias = path.join(f.root, "alias");
  fs.symlinkSync(f.area, alias);
  const target = f.target();
  assert.equal(
    (await copyIn({ area: alias, requested: "build/app.apk", target, maxBytes: 1000 }))
      .bytes,
    9,
  );
});

test("a name swapped for a link after the check is not followed", async (t) => {
  const f = fixture(t);
  // What `locate` answered is opened name by name, without following a link: the
  // folder it named is now a link out of the area.
  const place = locate(f.area, "build/app.apk");
  assert.deepEqual(place, { root: f.area, folder: "build", name: "app.apk" });
  fs.renameSync(path.join(f.area, "build"), path.join(f.area, "real-build"));
  fs.mkdirSync(path.join(f.root, "elsewhere"));
  fs.writeFileSync(path.join(f.root, "elsewhere", "app.apk"), "other bytes");
  fs.symlinkSync(path.join(f.root, "elsewhere"), path.join(f.area, "build"));
  // Resolved again it is outside; and the walk itself refuses the link.
  await assert.rejects(f.read("build/app.apk"), outside);
  const { FileNative } = await import("../../server/features/files/file-native.js");
  const native = new FileNative();
  t.after(() => native.close());
  const root = await native.run("openRoot", { path: place.root });
  await assert.rejects(
    native.run("openLookup", { directory: root.handle, path: place.folder }),
    { code: "FILE_PATH_CHANGED" },
  );
});

test("the size limit holds for a file that is read", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.area, "big.apk"), "x".repeat(1001));
  const target = f.target();
  await assert.rejects(
    copyIn({ area: f.area, requested: "big.apk", target, maxBytes: 1000 }),
    (error) => error.code === "DEVICE_FILE_TOO_LARGE" && error.limit === 1000,
  );
  assert.equal(fs.existsSync(target), false);
  fs.writeFileSync(path.join(f.area, "fits.apk"), "x".repeat(1000));
  assert.equal((await f.read("fits.apk")).bytes, 1000);
  // Larger than one read of the native helper.
  fs.writeFileSync(path.join(f.area, "chunks.bin"), Buffer.alloc(200000, 7));
  const large = f.target();
  await copyIn({ area: f.area, requested: "chunks.bin", target: large, maxBytes: 2e6 });
  assert.deepEqual(fs.readFileSync(large), Buffer.alloc(200000, 7));
});

test("AgentPier's own data folder is no area and no part of one", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.data, "auth.json"), "{}");
  const protectedRoots = [f.data];
  // A session that works in the data folder, or above it, reads nothing of it.
  await assert.rejects(
    copyIn({
      area: f.data,
      requested: "auth.json",
      target: f.target(),
      maxBytes: 1000,
      protectedRoots,
    }),
    outside,
  );
  await assert.rejects(
    copyIn({
      area: f.root,
      requested: "data/auth.json",
      target: f.target(),
      maxBytes: 1000,
      protectedRoots,
    }),
    outside,
  );
  // The rest of that wider area is fine.
  assert.equal(
    (
      await copyIn({
        area: f.root,
        requested: "secret.txt",
        target: f.target(),
        maxBytes: 1000,
        protectedRoots,
      })
    ).bytes,
    10,
  );
  await assert.rejects(f.write("../data/pulled.txt", "x", { protectedRoots }), outside);
});

test("a file is written into the area and replaces a regular file", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.write("build/pulled.txt", "from the device"), {
    bytes: 15,
    name: "pulled.txt",
  });
  const written = path.join(f.area, "build", "pulled.txt");
  assert.equal(fs.readFileSync(written, "utf8"), "from the device");
  assert.equal(fs.statSync(written).mode & 0o777, 0o600);
  await f.write("build/pulled.txt", "again");
  assert.equal(fs.readFileSync(written, "utf8"), "again");
  await f.write(path.join(f.area, "top.txt"), "at the root");
  assert.equal(fs.readFileSync(path.join(f.area, "top.txt"), "utf8"), "at the root");
  // No temporary file stays behind.
  assert.deepEqual(fs.readdirSync(path.join(f.area, "build")).sort(), [
    "app.apk",
    "pulled.txt",
  ]);
  // Larger than one write of the native helper.
  const large = f.target();
  fs.writeFileSync(large, Buffer.alloc(200000, 9));
  await copyOut({ area: f.area, requested: "large.bin", source: large, maxBytes: 2e6 });
  assert.deepEqual(
    fs.readFileSync(path.join(f.area, "large.bin")),
    Buffer.alloc(200000, 9),
  );
});

test("nothing is written outside the area, through a link or over one", async (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.root, path.join(f.area, "up"));
  fs.symlinkSync(path.join(f.root, "secret.txt"), path.join(f.area, "leak.txt"));
  fs.symlinkSync(path.join(f.root, "new.txt"), path.join(f.area, "dangling.txt"));
  for (const requested of [
    "../escaped.txt",
    "up/escaped.txt",
    path.join(f.root, "escaped.txt"),
    "leak.txt",
    "dangling.txt",
    "build",
    ".",
  ])
    await assert.rejects(f.write(requested), outside, requested);
  await assert.rejects(f.write("no-such-folder/file.txt"), missing);
  assert.equal(fs.readFileSync(path.join(f.root, "secret.txt"), "utf8"), "the secret");
  assert.equal(fs.existsSync(path.join(f.root, "escaped.txt")), false);
  assert.equal(fs.existsSync(path.join(f.root, "new.txt")), false);
  assert.deepEqual(fs.readdirSync(f.area).sort(), [
    "build",
    "dangling.txt",
    "leak.txt",
    "up",
  ]);
  // A link to a folder inside the area is a way to write there.
  fs.symlinkSync(path.join(f.area, "build"), path.join(f.area, "out"));
  await f.write("out/via-link.txt", "ok");
  assert.equal(fs.readFileSync(path.join(f.area, "build", "via-link.txt"), "utf8"), "ok");
});

test("the size limit holds for a file that is written", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.write("big.txt", "x".repeat(1001)),
    refused("DEVICE_FILE_TOO_LARGE"),
  );
  assert.equal(fs.existsSync(path.join(f.area, "big.txt")), false);
  assert.deepEqual(fs.readdirSync(f.area), ["build"]);
});
