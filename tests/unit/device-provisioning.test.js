import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeAndroidSdk, installFakeSdk } from "../helpers/fake-android-sdk.js";
import { androidManifest } from "../../server/features/devices/android-manifest.js";
import {
  androidDevicesWanted,
  provisionAndroidDevices,
} from "../../server/features/devices/device-provisioning.js";
import { readDeviceSettings } from "../../server/features/devices/device-settings.js";

// The installer step of `--with-android-devices`: it leaves the request and the
// accepted terms for the server and downloads nothing.
function folder(t) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "device-provision-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const mac = { platform: "darwin", arch: "arm64" };
const linux = { platform: "linux", arch: "x64" };
const usable = () => null;
const file = (dir) => path.join(dir, "devices", "settings.json");
function printer() {
  const lines = [];
  return { lines, print: (line) => lines.push(line), text: () => lines.join("\n") };
}

test("without the flag and without a request nothing happens", async (t) => {
  const dataDir = folder(t);
  for (const host of [mac, linux, { platform: "linux", arch: "arm64" }]) {
    const out = printer();
    assert.equal(await provisionAndroidDevices({ dataDir, ...host, ...out }), null);
    assert.deepEqual(out.lines, []);
    assert.equal(androidDevicesWanted({ dataDir, ...host }), false);
  }
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

test("the flag stores the request and the terms, and says what is downloaded under which licences", async (t) => {
  const dataDir = folder(t);
  const out = printer();
  const result = await provisionAndroidDevices({
    dataDir,
    enable: true,
    ...mac,
    now: () => 1234,
    ...out,
  });
  assert.deepEqual(result, { status: "requested" });
  const settings = readDeviceSettings(dataDir);
  assert.equal(settings.requested, true);
  assert.equal(settings.failure, null);
  assert.deepEqual(settings.terms, {
    acceptedAt: 1234,
    by: "installer",
    versions: {
      emulator: androidManifest.emulator.version,
      platformTools: androidManifest.platformTools.version,
      image: androidManifest.image.id,
    },
  });
  assert.equal(fs.statSync(file(dataDir)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file(dataDir))).mode & 0o777, 0o700);
  // Only the settings: nothing was downloaded.
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "devices")), ["settings.json"]);
  const text = out.text();
  for (const licence of androidManifest.licences) {
    assert.ok(text.includes(licence.name), licence.name);
    assert.ok(text.includes(licence.url), licence.url);
  }
  // The Arm terms belong to the arm64 image: a Linux x64 host is not shown them.
  const onLinux = printer();
  await provisionAndroidDevices({
    dataDir: folder(t),
    enable: true,
    ...linux,
    problem: () => null,
    ...onLinux,
  });
  const [general, arm] = androidManifest.licences;
  assert.deepEqual(arm.platforms, ["darwin-arm64"]);
  assert.ok(onLinux.text().includes(general.url));
  assert.equal(onLinux.text().includes(arm.name), false);
  assert.equal(onLinux.text().includes(arm.url), false);
  assert.match(text, /dl\.google\.com/);
  // The download size of this host, in gigabytes.
  assert.match(text, /\b[1-9](?:\.\d)? GB\b/);
  assert.match(text, /--with-android-devices/);
  assert.match(text, /accept/i);
  for (const version of ["37.3.10", "37.0.3"]) assert.ok(text.includes(version), version);
  assert.equal(androidDevicesWanted({ dataDir, ...mac }), true);

  // Again: the same request, the owner's limits and the first acceptance stay.
  const before = fs.readFileSync(file(dataDir), "utf8");
  assert.deepEqual(
    await provisionAndroidDevices({ dataDir, enable: true, ...mac, now: () => 9999 }),
    { status: "requested" },
  );
  assert.equal(fs.readFileSync(file(dataDir), "utf8"), before);
  // A later run without the flag reports the pending request and prints nothing.
  const quiet = printer();
  assert.deepEqual(await provisionAndroidDevices({ dataDir, ...mac, ...quiet }), {
    status: "requested",
  });
  assert.deepEqual(quiet.lines, []);
});

test("the flag asks again after a failed installation and keeps other settings", async (t) => {
  const dataDir = folder(t);
  fs.mkdirSync(path.join(dataDir, "devices"), { mode: 0o700 });
  const terms = { acceptedAt: 5, by: "owner", versions: { emulator: "1" } };
  fs.writeFileSync(
    file(dataDir),
    JSON.stringify({
      maxDevices: 9,
      requested: true,
      terms,
      failure: { code: "DEVICES_DOWNLOAD_FAILED", at: 7 },
    }),
  );
  const result = await provisionAndroidDevices({
    dataDir,
    enable: true,
    ...mac,
    print: () => {},
  });
  assert.deepEqual(result, { status: "requested" });
  const settings = readDeviceSettings(dataDir);
  assert.deepEqual(
    [settings.maxDevices, settings.requested, settings.failure, settings.terms],
    [9, true, null, terms],
  );
});

test("a host that cannot run devices is told why and nothing is written", async (t) => {
  const dataDir = folder(t);
  const cases = [
    [{ platform: "linux", arch: "arm64" }, undefined, /linux-arm64/],
    [{ platform: "darwin", arch: "x64" }, undefined, /darwin-x64/],
    // Linux x64 without /dev/kvm, and with one the user may not open.
    [linux, () => "DEVICES_KVM_MISSING", /\/dev\/kvm.*virtuali[sz]ation/is],
    [linux, () => "DEVICES_KVM_DENIED", /usermod -aG kvm/],
  ];
  for (const [host, problem, expected] of cases) {
    const out = printer();
    const result = await provisionAndroidDevices({
      dataDir,
      enable: true,
      ...host,
      ...(problem && { problem }),
      ...out,
    });
    assert.equal(result.status, "unavailable");
    assert.match(result.message, expected);
    assert.deepEqual(out.lines, []);
    assert.equal(androidDevicesWanted({ dataDir, ...host }), false);
  }
  assert.deepEqual(fs.readdirSync(dataDir), []);
  // The real check finds no /dev/kvm where there is none.
  const real = await provisionAndroidDevices({ dataDir, enable: true, ...linux });
  if (!fs.existsSync("/dev/kvm")) assert.equal(real.status, "unavailable");
  else assert.ok(["unavailable", "requested"].includes(real.status));
});

test("an installed SDK is reported and left alone", async (t) => {
  const fake = await fakeAndroidSdk();
  t.after(() => fake.cleanup());
  await installFakeSdk(fake.dataDir, fake.manifest);
  const host = { ...fake.host, manifest: fake.manifest, problem: usable };
  assert.equal(androidDevicesWanted({ dataDir: fake.dataDir, ...host }), true);
  for (const enable of [false, true]) {
    const out = printer();
    assert.deepEqual(
      await provisionAndroidDevices({ dataDir: fake.dataDir, enable, ...host, ...out }),
      { status: "installed" },
    );
    assert.deepEqual(out.lines, []);
  }
  assert.equal(fs.existsSync(fake.paths.settingsFile), false);
  // A later release pins another emulator: the flag requests the update.
  const later = await fake.pin({ emulator: "37.4.1", build: "17000000" });
  assert.deepEqual(
    await provisionAndroidDevices({
      dataDir: fake.dataDir,
      enable: true,
      ...host,
      manifest: later,
      print: () => {},
    }),
    { status: "requested" },
  );
  assert.equal(readDeviceSettings(fake.dataDir).terms.versions.emulator, "37.4.1");
});

test("a link in place of the devices folder fails with a message and writes nowhere", async (t) => {
  const dataDir = folder(t);
  const elsewhere = folder(t);
  fs.symlinkSync(elsewhere, path.join(dataDir, "devices"));
  const out = printer();
  const result = await provisionAndroidDevices({ dataDir, enable: true, ...mac, ...out });
  assert.equal(result.status, "failed");
  assert.ok(result.message);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.deepEqual(out.lines, []);
  // Neither does a data folder that cannot be written.
  const blocked = path.join(folder(t), "file");
  fs.writeFileSync(blocked, "x");
  const refused = await provisionAndroidDevices({
    dataDir: blocked,
    enable: true,
    ...mac,
    print: () => {},
  });
  assert.equal(refused.status, "failed");
  assert.ok(refused.message);
});
