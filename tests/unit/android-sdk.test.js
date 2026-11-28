import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  fakeAndroidSdk,
  installFakeSdk,
  waitUntil,
} from "../helpers/fake-android-sdk.js";
import { AndroidSdk } from "../../server/features/devices/android-sdk.js";
import { receiptFile } from "../../server/features/devices/device-paths.js";
import {
  readDeviceSettings,
  writeDeviceSettings,
} from "../../server/features/devices/device-settings.js";

// The installation job as the owner sees it (android-sdk.js), with the fake SDK of
// tests/helpers/fake-android-sdk.js: real downloads from a stand-in host, the real
// unpacker and the version checks against the fake executables.
async function fixture(t, { platform, ...options } = {}) {
  const sdk = await fakeAndroidSdk({ platform });
  const made = [];
  let clock = 1795000000000;
  const create = (overrides = {}) => {
    const changes = [];
    const android = new AndroidSdk({
      dataDir: sdk.dataDir,
      manifest: sdk.manifest,
      host: sdk.host,
      fetchImpl: sdk.fetchImpl,
      run: sdk.run,
      // The fake SDK is a Linux one wherever the test runs: no look at /dev/kvm.
      problem: () => null,
      now: () => clock++,
      changed: () => changes.push(android.status()),
      ...options,
      ...overrides,
    });
    android.changes = changes;
    made.push(android);
    return android;
  };
  t.after(async () => {
    await Promise.all(made.map((android) => android.close()));
    const recorded = await sdk.cleanup();
    for (const pid of recorded)
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
  const state = (android, wanted) =>
    waitUntil(() => android.status().state === wanted && !android.operation, {
      describe: `the state ${wanted}`,
    });
  const partials = () =>
    fs.existsSync(sdk.paths.downloads)
      ? fs.readdirSync(sdk.paths.downloads).filter((name) => name.endsWith(".partial"))
      : [];
  return { sdk, create, state, partials };
}
const refusal = (code, status = 409) => ({ code, status });
const terms = (by = "owner") => ({
  acceptedAt: 5,
  by,
  versions: { emulator: "37.3.10", platformTools: "37.0.3", image: "android-36" },
});

test("the status of a host without the SDK names what would be installed", async (t) => {
  const { sdk, create } = await fixture(t);
  const android = create();
  const archives = ["emulator", "platformTools", "image"].map(
    (name) => sdk.manifest[name].archives["linux-x64"],
  );
  assert.deepEqual(android.status(), {
    available: true,
    reason: null,
    state: "absent",
    updating: false,
    progress: null,
    failure: null,
    requested: false,
    terms: { accepted: false, acceptedAt: null, by: null },
    pinned: {
      emulator: "37.3.10",
      platformTools: "37.0.3",
      image: {
        id: "android-36-google_apis-r7",
        api: 36,
        tag: "google_apis",
        abi: "x86_64",
      },
      downloadBytes: archives.reduce((sum, archive) => sum + archive.size, 0),
      diskBytes: archives.reduce((sum, archive) => sum + archive.expandedBytes, 0),
    },
    installed: null,
    sources: ["dl.google.com"],
    licences: sdk.manifest.licences,
  });
  // A licence that applies to another platform only is not among the terms shown.
  const arm = { id: "arm-terms", name: "Arm terms", url: "https://example.test/arm" };
  const everywhere = { id: "sdk", name: "SDK terms", url: "https://example.test/sdk" };
  const manifest = {
    ...sdk.manifest,
    licences: [everywhere, { ...arm, platforms: ["darwin-arm64"] }],
  };
  assert.deepEqual(create({ manifest }).status().licences, [everywhere]);
  assert.deepEqual(
    create({
      manifest: { ...manifest, licences: [{ ...arm, platforms: ["linux-x64"] }] },
    }).status().licences,
    [arm],
  );
  assert.equal(android.available(), "DEVICES_NOT_INSTALLED");
  // Reading the status writes nothing.
  assert.equal(fs.existsSync(sdk.paths.root), false);
});

test("installing needs the accepted terms and a host that can run devices", async (t) => {
  const { sdk, create } = await fixture(t);
  const android = create();
  for (const options of [undefined, {}, { acceptTerms: false }, { acceptTerms: "yes" }])
    assert.throws(() => android.install(options), refusal("DEVICES_TERMS_REQUIRED", 400));
  assert.equal(android.status().state, "absent");
  assert.deepEqual(sdk.fetchImpl.requests, []);
  assert.equal(fs.existsSync(sdk.paths.settingsFile), false);

  // On a host that cannot run devices it is the host's code, terms or not.
  const kvm = create({ problem: () => "DEVICES_KVM_DENIED" });
  assert.throws(() => kvm.install({ acceptTerms: true }), refusal("DEVICES_KVM_DENIED"));
  assert.throws(() => kvm.install(), refusal("DEVICES_KVM_DENIED"));
  assert.equal(kvm.available(), "DEVICES_KVM_DENIED");
  assert.deepEqual(
    [kvm.status().available, kvm.status().reason, kvm.status().state],
    [false, "DEVICES_KVM_DENIED", "absent"],
  );
  assert.equal(kvm.resume().state, "absent");
  // The real check: there is no emulator build for Linux arm64.
  const arm = create({ problem: undefined, host: { platform: "linux", arch: "arm64" } });
  assert.throws(
    () => arm.install({ acceptTerms: true }),
    refusal("DEVICES_PLATFORM_UNSUPPORTED"),
  );
  const status = arm.status();
  assert.equal(status.reason, "DEVICES_PLATFORM_UNSUPPORTED");
  assert.deepEqual(status.pinned.image.abi, null);
  assert.equal(status.pinned.downloadBytes, 0);
  assert.deepEqual(sdk.fetchImpl.requests, []);
});

test("an installation answers at once, reports progress and ends installed", async (t) => {
  const { sdk, create, state } = await fixture(t);
  const android = create();
  // The image download delivers 64 bytes and then waits, so the middle is visible.
  sdk.fetchImpl.stallAfter(64, "sys-img");
  const first = android.install({ acceptTerms: true });
  assert.equal(first.state, "downloading");
  assert.equal(first.updating, false);
  assert.equal(first.requested, true);
  assert.deepEqual(first.terms, {
    accepted: true,
    acceptedAt: 1795000000000,
    by: "owner",
  });
  assert.deepEqual(readDeviceSettings(sdk.dataDir).terms.versions, {
    emulator: "37.3.10",
    platformTools: "37.0.3",
    image: "android-36-google_apis-r7",
  });
  // A second installation, or a removal, while one runs is refused.
  assert.throws(
    () => android.install({ acceptTerms: true }),
    refusal("DEVICES_OPERATION_RUNNING"),
  );
  assert.throws(() => android.remove(), refusal("DEVICES_OPERATION_RUNNING"));

  const image = sdk.manifest.image.archives["linux-x64"];
  const total = android.status().pinned.downloadBytes;
  const middle = await waitUntil(
    () => {
      const status = android.status();
      return status.progress?.received === total - image.size + 64 && status;
    },
    { describe: "the image download's first bytes" },
  );
  assert.deepEqual(middle.progress, {
    component: "image",
    received: total - image.size + 64,
    total,
  });
  assert.equal(middle.state, "downloading");
  // Platform tools and emulator are in place, but that is no usable SDK yet.
  assert.deepEqual(middle.installed, {
    emulator: "37.3.10",
    platformTools: "37.0.3",
    images: [],
  });
  assert.equal(android.available(), "DEVICES_NOT_INSTALLED");
  // The listener heard the same progress, each phase of each component.
  const heard = android.changes.filter((status) => status.progress);
  assert.deepEqual(heard.at(-1).progress, middle.progress);
  assert.deepEqual(
    [...new Set(heard.map((status) => `${status.progress.component} ${status.state}`))],
    [
      "platformTools downloading",
      "platformTools unpacking",
      "platformTools checking",
      "emulator downloading",
      "emulator unpacking",
      "emulator checking",
      "image downloading",
    ],
  );
  // The owner cancels and starts again: the image continues where it stopped.
  android.cancel();
  await state(android, "absent");
  sdk.fetchImpl.reset().requests.length = 0;
  android.install({ acceptTerms: true });
  await state(android, "installed");
  assert.deepEqual(sdk.fetchImpl.requests, [{ url: image.url, range: "bytes=64-" }]);
  const done = android.status();
  assert.deepEqual(
    [done.updating, done.progress, done.failure, done.requested],
    [false, null, null, true],
  );
  assert.deepEqual(done.installed, {
    emulator: "37.3.10",
    platformTools: "37.0.3",
    images: ["android-36-google_apis-r7"],
  });
  assert.equal(android.available(), null);
  assert.deepEqual(android.changes.at(-1), done);
  assert.equal(readDeviceSettings(sdk.dataDir).operation, null);
  // Installing what is installed only records the acceptance again.
  sdk.fetchImpl.requests.length = 0;
  assert.equal(
    android.install({ acceptTerms: true, by: "installer" }).state,
    "installed",
  );
  assert.equal(android.status().terms.by, "installer");
  assert.deepEqual(sdk.fetchImpl.requests, []);
});

test("cancelling ends in absent and keeps the partial download", async (t) => {
  const { sdk, create, state, partials } = await fixture(t);
  const android = create();
  sdk.fetchImpl.stallAfter(40, "platform-tools");
  android.install({ acceptTerms: true });
  await waitUntil(() => android.status().progress?.received === 40, {
    describe: "the first bytes",
  });
  assert.equal(android.cancel().state, "downloading");
  await state(android, "absent");
  const status = android.status();
  assert.deepEqual(
    [status.failure, status.requested, status.progress, status.installed],
    [null, false, null, null],
  );
  // The acceptance stays; the bytes stay for the next attempt.
  assert.equal(status.terms.accepted, true);
  assert.deepEqual(partials(), [
    `${path.basename(sdk.manifest.platformTools.archives["linux-x64"].url)}.partial`,
  ]);
  assert.equal(fs.statSync(path.join(sdk.paths.downloads, partials()[0])).size, 40);
  // Nothing is pending: a restart does not start it again.
  assert.equal(android.resume().state, "absent");
  // Cancelling without a running installation changes nothing.
  assert.equal(android.cancel().state, "absent");
});

test("a failed installation shows its code and can be tried again", async (t) => {
  const { sdk, create, state } = await fixture(t);
  const android = create();
  sdk.fetchImpl.corrupt("emulator-");
  android.install({ acceptTerms: true });
  await state(android, "failed");
  const failed = android.status();
  assert.deepEqual(failed.failure, {
    code: "DEVICES_CHECKSUM_MISMATCH",
    at: failed.failure.at,
  });
  assert.equal(failed.requested, true);
  assert.deepEqual(failed.installed, {
    emulator: null,
    platformTools: "37.0.3",
    images: [],
  });
  assert.equal(android.available(), "DEVICES_NOT_INSTALLED");
  // A failure is not retried by a restart: the owner decides.
  assert.equal(android.resume().state, "failed");

  // Libraries the host lacks are named in the failure.
  sdk.fetchImpl.reset();
  const lacking = create({
    run: async (command, args) => {
      if (command === "ldd") return "\tlibX11.so.6 => not found\n";
      return args[0] === "version" ? "Version 37.0.3-1\n" : "unused";
    },
  });
  lacking.install({ acceptTerms: true });
  await state(lacking, "failed");
  assert.deepEqual(lacking.status().failure.detail, { missing: ["libX11.so.6"] });
  assert.equal(lacking.status().failure.code, "DEVICES_SDK_UNUSABLE");

  // The next attempt clears the failure and finishes.
  android.install({ acceptTerms: true });
  assert.equal(android.status().failure, null);
  await state(android, "installed");
  assert.equal(android.status().failure, null);
});

test("removing is refused while a device runs and ends in absent", async (t) => {
  const { sdk, create, state } = await fixture(t);
  await installFakeSdk(sdk.dataDir, sdk.manifest);
  writeDeviceSettings(sdk.dataDir, { requested: true, terms: terms(), maxDevices: 7 });
  let running = true;
  const android = create({ inUse: () => running });
  assert.equal(android.status().state, "installed");
  assert.throws(() => android.remove(), refusal("DEVICES_IN_USE"));
  assert.equal(android.status().state, "installed");
  assert.ok(fs.existsSync(sdk.paths.emulatorBin));

  running = false;
  fs.mkdirSync(sdk.paths.home, { recursive: true });
  fs.writeFileSync(path.join(sdk.paths.home, "adbkey"), "key");
  assert.equal(android.remove().state, "removing");
  assert.equal(android.available(), "DEVICES_NOT_INSTALLED");
  assert.throws(
    () => android.install({ acceptTerms: true }),
    refusal("DEVICES_OPERATION_RUNNING"),
  );
  await state(android, "absent");
  const status = android.status();
  assert.deepEqual(
    [status.installed, status.requested, status.terms.accepted, status.failure],
    [null, false, false, null],
  );
  for (const gone of [sdk.paths.sdk, sdk.paths.home, sdk.paths.downloads])
    assert.equal(fs.existsSync(gone), false);
  // The owner's limits are settings, not part of the installation.
  assert.equal(readDeviceSettings(sdk.dataDir).maxDevices, 7);
  assert.equal(android.changes.at(-1).state, "absent");
});

test("an installation the last process did not finish is interrupted", async (t) => {
  const { sdk, create } = await fixture(t);
  writeDeviceSettings(sdk.dataDir, {
    requested: true,
    terms: terms(),
    operation: { kind: "install", startedAt: 3 },
  });
  fs.mkdirSync(path.join(sdk.paths.sdk, ".stage-left/emulator"), { recursive: true });
  fs.mkdirSync(sdk.paths.downloads, { recursive: true });
  fs.writeFileSync(path.join(sdk.paths.downloads, "emulator.zip.partial"), "part");
  const android = create();
  android.recover();
  const status = android.status();
  assert.equal(status.state, "failed");
  assert.deepEqual(status.failure, {
    code: "DEVICES_INTERRUPTED",
    at: status.failure.at,
  });
  assert.equal(readDeviceSettings(sdk.dataDir).operation, null);
  assert.equal(android.changes.length, 1);
  // The half-unpacked stage is gone; the partial download waits for the owner.
  assert.deepEqual(fs.readdirSync(sdk.paths.sdk), []);
  assert.ok(fs.existsSync(path.join(sdk.paths.downloads, "emulator.zip.partial")));
  // It is not started again by itself, and a second look changes nothing.
  assert.equal(android.resume().state, "failed");
  android.recover();
  assert.equal(android.changes.length, 1);
  assert.deepEqual(sdk.fetchImpl.requests, []);
});

test("a removal the last process did not finish is completed", async (t) => {
  const { sdk, create } = await fixture(t);
  await installFakeSdk(sdk.dataDir, sdk.manifest);
  fs.rmSync(sdk.paths.emulator, { recursive: true });
  writeDeviceSettings(sdk.dataDir, {
    requested: true,
    terms: terms(),
    operation: { kind: "remove", startedAt: 3 },
  });
  const android = create();
  android.recover();
  const status = android.status();
  assert.deepEqual(
    [status.state, status.installed, status.requested, status.failure],
    ["absent", null, false, null],
  );
  assert.equal(fs.existsSync(sdk.paths.sdk), false);
});

test("a restart installs a pending request without asking for the terms", async (t) => {
  const { sdk, create, state } = await fixture(t);
  // What the installer option leaves: a request with the terms it printed.
  writeDeviceSettings(sdk.dataDir, { requested: true, terms: terms("installer") });
  const android = create();
  android.recover();
  assert.equal(android.resume().state, "downloading");
  await state(android, "installed");
  assert.deepEqual(android.status().terms, {
    accepted: true,
    acceptedAt: 5,
    by: "installer",
  });
  // Nothing to do on the next start.
  sdk.fetchImpl.requests.length = 0;
  assert.equal(android.resume().state, "installed");
  assert.deepEqual(sdk.fetchImpl.requests, []);

  // Without accepted terms a request alone installs nothing.
  const other = await fixture(t);
  writeDeviceSettings(other.sdk.dataDir, { requested: true });
  assert.equal(other.create().resume().state, "absent");
  assert.deepEqual(other.sdk.fetchImpl.requests, []);
});

test("a restart brings an installed SDK to a newer pin and prunes unused images", async (t) => {
  const { sdk, create, state } = await fixture(t);
  await installFakeSdk(sdk.dataDir, sdk.manifest);
  writeDeviceSettings(sdk.dataDir, { requested: true, terms: terms() });
  const later = await sdk.pin({
    emulator: "37.4.1",
    build: "17000000",
    image: { api: 37, revision: 1 },
  });
  const old = sdk.manifest.image.id;
  let running = true;
  let named = [old];
  const android = create({
    manifest: later,
    inUse: () => running,
    imagesInUse: () => named,
  });
  android.recover();
  // Behind the pin the SDK still works; while a device runs it is left alone.
  assert.equal(android.status().state, "installed");
  assert.equal(android.available(), null);
  assert.equal(android.resume().state, "installed");
  assert.deepEqual(sdk.fetchImpl.requests, []);
  // The owner's own "install" is refused for the same reason.
  assert.throws(() => android.install({ acceptTerms: true }), refusal("DEVICES_IN_USE"));

  running = false;
  const started = android.resume();
  assert.equal(started.state, "downloading");
  assert.equal(started.updating, true);
  await state(android, "installed");
  const status = android.status();
  assert.equal(status.updating, false);
  assert.deepEqual(status.installed, {
    emulator: "37.4.1",
    platformTools: "37.0.3",
    images: [old, "android-37-google_apis-r1"],
  });
  // The acceptance is the one given for the earlier pin.
  assert.deepEqual(status.terms, { accepted: true, acceptedAt: 5, by: "owner" });
  assert.deepEqual(
    sdk.fetchImpl.requests.map((request) => request.url),
    [later.emulator.archives["linux-x64"].url, later.image.archives["linux-x64"].url],
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(sdk.paths.emulator, receiptFile))).version,
    "37.4.1",
  );
  // Once no device names the old image, the next start removes it.
  named = [];
  android.resume();
  assert.deepEqual(android.status().installed.images, ["android-37-google_apis-r1"]);
});

test("a shutdown stops the download and the next start continues it", async (t) => {
  const { sdk, create, state, partials } = await fixture(t);
  const android = create();
  sdk.fetchImpl.stallAfter(30, "platform-tools");
  android.install({ acceptTerms: true });
  await waitUntil(() => android.status().progress?.received === 30, {
    describe: "the first bytes",
  });
  await android.close();
  assert.equal(android.operation, null);
  assert.deepEqual(readDeviceSettings(sdk.dataDir).operation, null);
  assert.equal(readDeviceSettings(sdk.dataDir).requested, true);
  assert.equal(readDeviceSettings(sdk.dataDir).failure, null);
  assert.equal(partials().length, 1);
  // A closed service starts nothing more.
  assert.throws(
    () => android.install({ acceptTerms: true }),
    refusal("DEVICES_OPERATION_RUNNING"),
  );
  assert.equal(android.resume().state, "absent");

  sdk.fetchImpl.reset().requests.length = 0;
  const next = create();
  next.recover();
  assert.equal(next.status().failure, null);
  assert.equal(next.resume().state, "downloading");
  await state(next, "installed");
  assert.equal(sdk.fetchImpl.requests[0].range, "bytes=30-");
});
