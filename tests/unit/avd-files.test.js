import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { androidManifest } from "../../server/features/devices/android-manifest.js";
import {
  avdBytes,
  avdConfig,
  hasAvd,
  hasSnapshot,
  isDeviceId,
  removeAvd,
  writeAvd,
} from "../../server/features/devices/avd-files.js";
import { devicePaths } from "../../server/features/devices/device-paths.js";

// The AVD files AgentPier writes itself, instead of avdmanager (no Java).
const id = "d-0123456789ab";
const image = androidManifest.image.id;
const { shape } = androidManifest;
// The keys that boot and resolve the same hardware as an avdmanager AVD, in order.
const keys = [
  "avd.ini.encoding",
  "abi.type",
  "hw.cpu.arch",
  "hw.cpu.ncore",
  "hw.ramSize",
  "hw.lcd.width",
  "hw.lcd.height",
  "hw.lcd.density",
  "hw.gpu.enabled",
  "hw.gpu.mode",
  "hw.keyboard",
  "hw.keyboard.lid",
  "hw.dPad",
  "hw.mainKeys",
  "hw.trackBall",
  "hw.sdCard",
  "image.sysdir.1",
  "tag.id",
  "tag.display",
  "target",
  "PlayStore.enabled",
  "disk.dataPartition.size",
  "fastboot.forceFastBoot",
  "vm.heapSize",
];

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "avd-files-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return devicePaths(dataDir, androidManifest, { platform: "linux", arch: "x64" });
}
const mode = (file) => fs.statSync(file).mode & 0o777;

test("the configuration holds exactly the proved keys", () => {
  const config = avdConfig({ id, image, abi: "x86_64", shape });
  assert.deepEqual(Object.keys(config), keys);
  assert.equal(keys.length, 24);
  assert.deepEqual(
    {
      abi: config["abi.type"],
      arch: config["hw.cpu.arch"],
      cores: config["hw.cpu.ncore"],
      ram: config["hw.ramSize"],
      screen: `${config["hw.lcd.width"]}x${config["hw.lcd.height"]}@${config["hw.lcd.density"]}`,
      target: config.target,
      tag: config["tag.id"],
      display: config["tag.display"],
      data: config["disk.dataPartition.size"],
    },
    {
      abi: "x86_64",
      arch: "x86_64",
      cores: "4",
      ram: "2048",
      screen: "720x1600@320",
      target: "android-36",
      tag: "google_apis",
      display: "Google APIs",
      data: "6G",
    },
  );
  // Relative to the SDK, so the emulator resolves it below ANDROID_SDK_ROOT.
  assert.equal(
    config["image.sysdir.1"],
    "system-images/android-36-google_apis-r7/x86_64/",
  );
  assert.equal(avdConfig({ id, image, abi: "arm64-v8a", shape })["hw.cpu.arch"], "arm64");
  assert.throws(() => avdConfig({ id, image, abi: "mips", shape }), TypeError);
  assert.throws(() => avdConfig({ id, image: "android-36", abi: "x86_64", shape }));
});

test("writeAvd writes the ini file and config.ini for the owner only", (t) => {
  const paths = fixture(t);
  assert.equal(hasAvd(paths, id), false);
  writeAvd(paths, { id, image, abi: "x86_64", shape });
  const folder = path.join(paths.avd, `${id}.avd`);
  assert.equal(
    fs.readFileSync(path.join(paths.avd, `${id}.ini`), "utf8"),
    `avd.ini.encoding=UTF-8\npath=${folder}\ntarget=android-36\n`,
  );
  const lines = fs.readFileSync(path.join(folder, "config.ini"), "utf8").split("\n");
  assert.equal(lines.pop(), "");
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf("="))),
    keys,
  );
  assert.ok(lines.includes(`image.sysdir.1=system-images/${image}/x86_64/`));
  assert.equal(mode(folder), 0o700);
  assert.equal(mode(path.join(folder, "config.ini")), 0o600);
  assert.equal(mode(path.join(paths.avd, `${id}.ini`)), 0o600);
  assert.equal(hasAvd(paths, id), true);
  // Writing again replaces both files and leaves nothing temporary.
  writeAvd(paths, { id, image, abi: "x86_64", shape });
  assert.deepEqual(fs.readdirSync(folder), ["config.ini"]);
  assert.deepEqual(fs.readdirSync(paths.avd).sort(), [`${id}.avd`, `${id}.ini`]);
});

test("only a device id names an AVD", (t) => {
  const paths = fixture(t);
  const outside = path.join(paths.root, "keep.avd");
  fs.mkdirSync(outside, { recursive: true });
  for (const bad of [
    "../keep",
    "proof1",
    "d-0123456789AB",
    "d-0123456789abc",
    "",
    null,
  ]) {
    assert.equal(isDeviceId(bad), false);
    assert.throws(() => removeAvd(paths, bad), TypeError);
    assert.throws(() => writeAvd(paths, { id: bad, image, abi: "x86_64", shape }));
    assert.throws(() => hasSnapshot(paths, bad), TypeError);
  }
  assert.equal(fs.existsSync(outside), true);
  assert.equal(isDeviceId(id), true);
});

test("removeAvd removes both files; a snapshot and the size are read from the folder", async (t) => {
  const paths = fixture(t);
  writeAvd(paths, { id, image, abi: "x86_64", shape });
  const other = "d-ffffffffffff";
  writeAvd(paths, { id: other, image, abi: "x86_64", shape });
  assert.equal(hasSnapshot(paths, id), false);
  const snapshot = path.join(paths.avd, `${id}.avd`, "snapshots", "default_boot");
  fs.mkdirSync(snapshot, { recursive: true });
  // An empty folder is no snapshot.
  assert.equal(hasSnapshot(paths, id), false);
  fs.writeFileSync(path.join(snapshot, "ram.bin"), Buffer.alloc(65536, 1));
  assert.equal(hasSnapshot(paths, id), true);
  assert.ok((await avdBytes(paths, id)) >= 65536);
  assert.ok((await avdBytes(paths, id)) > (await avdBytes(paths, other)));
  removeAvd(paths, id);
  assert.deepEqual(fs.readdirSync(paths.avd).sort(), [`${other}.avd`, `${other}.ini`]);
  assert.equal(hasSnapshot(paths, id), false);
  assert.equal(await avdBytes(paths, id), 0);
  // Removing what is not there is not an error.
  removeAvd(paths, id);
});
