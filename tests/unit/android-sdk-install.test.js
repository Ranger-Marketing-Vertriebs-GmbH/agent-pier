import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fakeAndroidSdk, installFakeSdk } from "../helpers/fake-android-sdk.js";
import {
  ensureSdk,
  installedSdk,
  pruneImages,
  removeSdk,
  sweepSdk,
} from "../../server/features/devices/android-sdk-install.js";
import { devicePaths, receiptFile } from "../../server/features/devices/device-paths.js";

// Installing the pinned SDK components (android-sdk-install.js) from the fake
// archives of tests/helpers/fake-android-sdk.js: the real download, unpacker and
// version checks run, against fake executables and a stand-in download host.
async function fixture(t, options) {
  const sdk = await fakeAndroidSdk(options);
  t.after(async () => {
    const recorded = await sdk.cleanup();
    for (const pid of recorded)
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
  const install = (overrides = {}) =>
    ensureSdk({
      paths: sdk.paths,
      manifest: sdk.manifest,
      key: sdk.key,
      fetchImpl: sdk.fetchImpl,
      ...overrides,
    });
  return { sdk, paths: sdk.paths, install };
}
const receiptOf = (directory) =>
  JSON.parse(fs.readFileSync(path.join(directory, receiptFile), "utf8"));
const stages = (paths) =>
  fs.existsSync(paths.sdk)
    ? fs.readdirSync(paths.sdk).filter((name) => name.startsWith(".stage-"))
    : [];
const ranges = (sdk) => sdk.fetchImpl.requests.map((request) => request.range);

test("the three components install from their archives with matching receipts", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  assert.deepEqual(installedSdk(paths, sdk.manifest, sdk.key), {
    emulator: null,
    platformTools: null,
    images: [],
    current: false,
  });
  const progress = [];
  const installed = await install({ onProgress: (step) => progress.push(step) });
  assert.deepEqual(installed, {
    emulator: "37.3.10",
    platformTools: "37.0.3",
    images: ["android-36-google_apis-r7"],
    current: true,
  });
  assert.deepEqual(installed, installedSdk(paths, sdk.manifest, sdk.key));
  const archives = (name) => sdk.manifest[name].archives[sdk.key];
  assert.deepEqual(receiptOf(paths.platformTools), {
    version: "37.0.3",
    sha256: archives("platformTools").sha256,
  });
  assert.deepEqual(receiptOf(paths.emulator), {
    version: "37.3.10",
    sha256: archives("emulator").sha256,
  });
  assert.deepEqual(receiptOf(paths.image()), {
    version: "android-36-google_apis-r7",
    sha256: archives("image").sha256,
  });
  // Platform tools first, then the emulator, then the image; each from its address.
  assert.deepEqual(
    sdk.fetchImpl.requests,
    ["platformTools", "emulator", "image"].map((name) => ({
      url: archives(name).url,
      range: null,
    })),
  );
  // Executable bits survive, nested folders exist, and nothing is left over.
  assert.equal(fs.statSync(paths.emulatorBin).mode & 0o100, 0o100);
  assert.equal(fs.statSync(paths.adbBin).mode & 0o100, 0o100);
  assert.equal(
    fs.statSync(path.join(paths.emulator, "lib64/libfake.so")).mode & 0o111,
    0,
  );
  assert.ok(fs.existsSync(path.join(paths.emulator, "lib64/libfake.so")));
  assert.ok(fs.existsSync(path.join(paths.image(), "data/misc/placeholder")));
  assert.deepEqual(stages(paths), []);
  assert.deepEqual(fs.readdirSync(paths.downloads), []);
  assert.equal(fs.statSync(paths.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.sdk).mode & 0o777, 0o700);
  // Progress counts the bytes of all three downloads and names the phases in order.
  const total = ["platformTools", "emulator", "image"].reduce(
    (sum, name) => sum + archives(name).size,
    0,
  );
  assert.ok(progress.every((step) => step.total === total));
  assert.deepEqual(progress.at(0), {
    component: "platformTools",
    phase: "downloading",
    received: 0,
    total,
  });
  assert.deepEqual(progress.at(-1), {
    component: "image",
    phase: "checking",
    received: total,
    total,
  });
  assert.deepEqual(
    progress.map((step) => step.received),
    [...progress.map((step) => step.received)].sort((a, b) => a - b),
  );
  assert.deepEqual(
    [...new Set(progress.map((step) => `${step.component} ${step.phase}`))],
    ["platformTools", "emulator", "image"].flatMap((name) =>
      ["downloading", "unpacking", "checking"].map((phase) => `${name} ${phase}`),
    ),
  );
  // A second call finds everything installed and asks the host for nothing.
  sdk.fetchImpl.requests.length = 0;
  assert.equal((await install()).current, true);
  assert.deepEqual(sdk.fetchImpl.requests, []);
  // The helper's ready-made installation is what an installation leaves.
  const other = devicePaths(path.join(sdk.root, "other"), sdk.manifest, sdk.host);
  await installFakeSdk(path.join(sdk.root, "other"), sdk.manifest);
  assert.deepEqual(installedSdk(other, sdk.manifest, sdk.key), installed);
  assert.deepEqual(receiptOf(other.emulator), receiptOf(paths.emulator));
});

test("a download that broke off continues with a range request", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  const archive = sdk.manifest.emulator.archives[sdk.key];
  const partial = path.join(paths.downloads, `${path.basename(archive.url)}.partial`);
  // Every transfer of the emulator archive ends after 100 bytes.
  sdk.fetchImpl.failAfter(100, "emulator-");
  await assert.rejects(install(), { code: "DEVICES_DOWNLOAD_FAILED" });
  // Three attempts, each continuing the last, and their bytes are kept.
  assert.deepEqual(ranges(sdk), [null, null, "bytes=100-", "bytes=200-"]);
  assert.equal(fs.statSync(partial).size, 300);
  assert.equal(fs.statSync(partial).mode & 0o777, 0o600);
  assert.deepEqual(installedSdk(paths, sdk.manifest, sdk.key), {
    emulator: null,
    platformTools: "37.0.3",
    images: [],
    current: false,
  });
  assert.equal(fs.existsSync(paths.emulator), false);

  sdk.fetchImpl.reset().requests.length = 0;
  const installed = await install();
  assert.equal(installed.current, true);
  // The platform tools are not fetched again; the emulator continues at byte 300.
  assert.deepEqual(sdk.fetchImpl.requests, [
    { url: archive.url, range: "bytes=300-" },
    { url: sdk.manifest.image.archives[sdk.key].url, range: null },
  ]);
  assert.equal(fs.existsSync(partial), false);
});

test("the caller's stop during a stalled download keeps its bytes", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  sdk.fetchImpl.stallAfter(50, "platform-tools");
  const controller = new AbortController();
  const pending = install({ signal: controller.signal });
  const partial = path.join(
    paths.downloads,
    `${path.basename(sdk.manifest.platformTools.archives[sdk.key].url)}.partial`,
  );
  // The caller gives up while nothing arrives: the bytes so far stay.
  await new Promise((resolve) => {
    const look = () =>
      fs.existsSync(partial) && fs.statSync(partial).size === 50
        ? resolve()
        : setImmediate(look);
    look();
  });
  controller.abort();
  await assert.rejects(pending, { code: "DEVICES_DOWNLOAD_CANCELLED" });
  assert.equal(fs.statSync(partial).size, 50);
  assert.deepEqual(stages(paths), []);
});

test("a corrupted archive is a checksum mismatch and installs nothing", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  sdk.fetchImpl.corrupt("platform-tools");
  await assert.rejects(install(), { code: "DEVICES_CHECKSUM_MISMATCH" });
  // Not tried again, nothing kept, nothing unpacked.
  assert.equal(sdk.fetchImpl.requests.length, 1);
  assert.deepEqual(fs.readdirSync(paths.downloads), []);
  assert.equal(fs.existsSync(paths.platformTools), false);
  assert.equal(fs.existsSync(paths.emulator), false);
  assert.deepEqual(stages(paths), []);
});

test("too little free space is refused before any request", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  const sum = (field) =>
    ["platformTools", "emulator", "image"].reduce(
      (total, name) => total + sdk.manifest[name].archives[sdk.key][field],
      0,
    );
  // The download, the unpacked files and one gibibyte in reserve must fit.
  const needed = sum("size") + sum("expandedBytes") + 2 ** 30;
  const asked = [];
  let free = needed - 1;
  t.mock.method(fsp, "statfs", async (directory) => {
    asked.push(directory);
    return { bavail: BigInt(free), bsize: 1n };
  });
  await assert.rejects(install(), { code: "DEVICES_DISK_SPACE" });
  assert.deepEqual(sdk.fetchImpl.requests, []);
  assert.deepEqual(asked, [paths.root]);
  assert.equal(fs.existsSync(paths.emulator), false);
  free = needed;
  assert.equal((await install()).current, true);
});

test("a full disk while unpacking keeps the earlier SDK and leaves no stage", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  await install();
  const before = receiptOf(paths.emulator);
  const later = await sdk.pin({ emulator: "37.4.1", build: "17000000" });
  let staged = null;
  const full = async (file, destination, top) => {
    staged = destination;
    fs.mkdirSync(path.join(destination, top));
    fs.writeFileSync(path.join(destination, top, "half-written"), "x");
    throw Object.assign(Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
    });
  };
  await assert.rejects(install({ manifest: later, unpack: full }), {
    code: "DEVICES_DISK_SPACE",
  });
  assert.equal(path.dirname(staged), paths.sdk);
  assert.match(path.basename(staged), /^\.stage-/);
  assert.equal(fs.existsSync(staged), false);
  assert.deepEqual(stages(paths), []);
  // The installed emulator is still the earlier one and still runs.
  assert.deepEqual(receiptOf(paths.emulator), before);
  assert.deepEqual(installedSdk(paths, sdk.manifest, sdk.key).current, true);
  assert.deepEqual(installedSdk(paths, later, sdk.key), {
    emulator: "37.3.10",
    platformTools: "37.0.3",
    images: ["android-36-google_apis-r7"],
    current: false,
  });
  // The verified download stays, so the next attempt fetches nothing new.
  sdk.fetchImpl.requests.length = 0;
  assert.equal((await install({ manifest: later })).emulator, "37.4.1");
  assert.deepEqual(ranges(sdk), [`bytes=${later.emulator.archives[sdk.key].size}-`]);
});

test("a new emulator pin replaces only the emulator", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  await install();
  const untouched = [paths.platformTools, paths.image()].map(
    (directory) => fs.statSync(path.join(directory, receiptFile)).ino,
  );
  const later = await sdk.pin({ emulator: "37.4.1", build: "17000000" });
  sdk.fetchImpl.requests.length = 0;
  assert.deepEqual(await install({ manifest: later }), {
    emulator: "37.4.1",
    platformTools: "37.0.3",
    images: ["android-36-google_apis-r7"],
    current: true,
  });
  assert.deepEqual(sdk.fetchImpl.requests, [
    { url: later.emulator.archives[sdk.key].url, range: null },
  ]);
  assert.deepEqual(receiptOf(paths.emulator), {
    version: "37.4.1",
    sha256: later.emulator.archives[sdk.key].sha256,
  });
  assert.deepEqual(
    [paths.platformTools, paths.image()].map(
      (directory) => fs.statSync(path.join(directory, receiptFile)).ino,
    ),
    untouched,
  );
  assert.deepEqual(stages(paths), []);
});

test("an old image stays while a device names it and leaves afterwards", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  await install();
  const old = sdk.manifest.image.id;
  const later = await sdk.pin({ image: { api: 37, revision: 2 } });
  const next = "android-37-google_apis-r2";
  assert.equal(later.image.id, next);
  const withDevice = await install({ manifest: later, keepImages: [old] });
  assert.deepEqual(withDevice.images, [old, next].sort());
  assert.equal(withDevice.current, true);
  assert.ok(fs.existsSync(path.join(paths.image(old, "x86_64"), "system.img")));
  assert.deepEqual(receiptOf(paths.image(next, "x86_64")).version, next);
  // Once no device names it, the next call removes it without a download.
  sdk.fetchImpl.requests.length = 0;
  assert.deepEqual((await install({ manifest: later })).images, [next]);
  assert.deepEqual(sdk.fetchImpl.requests, []);
  assert.deepEqual(fs.readdirSync(paths.images), [next]);
  // pruneImages by itself keeps exactly what it is told to.
  pruneImages(paths, []);
  assert.deepEqual(fs.readdirSync(paths.images), []);
  assert.equal(installedSdk(paths, later, sdk.key).current, false);
});

test("the sweep removes stage folders only", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  await install();
  fs.mkdirSync(path.join(paths.sdk, ".stage-left/emulator"), { recursive: true });
  fs.writeFileSync(path.join(paths.sdk, ".stage-left/emulator/emulator"), "half");
  fs.mkdirSync(path.join(paths.sdk, ".stage-other"));
  const partial = path.join(paths.downloads, "archive.zip.partial");
  fs.writeFileSync(partial, "part");
  sweepSdk(paths);
  assert.deepEqual(fs.readdirSync(paths.sdk).sort(), [
    "emulator",
    "platform-tools",
    "system-images",
  ]);
  assert.ok(fs.existsSync(partial));
  assert.equal(installedSdk(paths, sdk.manifest, sdk.key).current, true);
  // Without an SDK folder there is nothing to sweep.
  sweepSdk(devicePaths(path.join(sdk.root, "none"), sdk.manifest, sdk.host));
});

test("a component directory without its receipt is replaced", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  await install();
  fs.rmSync(path.join(paths.platformTools, receiptFile));
  fs.writeFileSync(path.join(paths.platformTools, "stray"), "x");
  assert.equal(installedSdk(paths, sdk.manifest, sdk.key).platformTools, null);
  sdk.fetchImpl.requests.length = 0;
  assert.equal((await install()).current, true);
  assert.equal(sdk.fetchImpl.requests.length, 1);
  assert.equal(fs.existsSync(path.join(paths.platformTools, "stray")), false);
});

test("a component that does not run or is another version is unusable", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  const outputs = {
    version: "Android Debug Bridge version 1.0.41\nVersion 37.0.3-1\n",
    "-version": "Android emulator version 37.3.10.0 (build_id 16970787) (CL:N/A)\n",
  };
  const calls = [];
  const run =
    (answers, ldd = "") =>
    async (command, args) => {
      calls.push([path.basename(command), ...args]);
      if (command === "ldd")
        return typeof ldd === "string" ? ldd : (ldd[path.basename(args[0])] ?? "");
      // The emulator is asked without a window: only that binary runs on a server.
      if (path.basename(command) === "emulator")
        assert.deepEqual(args, ["-no-window", "-version"]);
      const answer = answers[args.at(-1)];
      if (answer instanceof Error) throw answer;
      return answer;
    };
  const unusable = { code: "DEVICES_SDK_UNUSABLE" };
  // adb answers with another version.
  await assert.rejects(
    install({ run: run({ ...outputs, version: "Version 36.0.0-1\n" }) }),
    unusable,
  );
  assert.equal(fs.existsSync(paths.platformTools), false);
  // The emulator does not start (a missing library it loads late, or a signal).
  await assert.rejects(
    install({ run: run({ ...outputs, "-version": Error("exit") }) }),
    unusable,
  );
  // Another build of the same version is not the pinned one either.
  await assert.rejects(
    install({
      run: run({ ...outputs, "-version": outputs["-version"].replace("16970787", "1") }),
    }),
    unusable,
  );
  // On Linux, libraries the host lacks are named.
  const ldd =
    "\tlinux-vdso.so.1 (0x1)\n\tlibX11.so.6 => not found\n\tlibxcb.so.1 => not found\n" +
    "\tlibX11.so.6 => not found\n\tlibc.so.6 => /lib/libc.so.6 (0x2)\n";
  await assert.rejects(install({ run: run(outputs, ldd) }), (error) => {
    assert.equal(error.code, "DEVICES_SDK_UNUSABLE");
    assert.deepEqual(error.detail, { missing: ["libX11.so.6", "libxcb.so.1"] });
    return true;
  });
  // Both the launcher and the headless binary it starts are looked at; what only
  // the headless one lacks is named too.
  const looked = calls.filter(([command]) => command === "ldd").map(([, file]) => file);
  assert.deepEqual(
    [...new Set(looked.map((file) => path.basename(file)))],
    ["emulator", "qemu-system-x86_64-headless"],
  );
  assert.match(
    looked.find((file) => file.endsWith("-headless")),
    /[/]qemu[/]linux-x86_64[/]qemu-system-x86_64-headless$/,
  );
  await assert.rejects(
    install({
      run: run(outputs, {
        emulator: "\tlibc.so.6 => /lib/libc.so.6 (0x2)\n",
        "qemu-system-x86_64-headless":
          "\tlibX11.so.6 => not found\n\tlibc.so.6 => /lib/libc.so.6 (0x2)\n",
      }),
    }),
    (error) => {
      assert.equal(error.code, "DEVICES_SDK_UNUSABLE");
      assert.deepEqual(error.detail, { missing: ["libX11.so.6"] });
      return true;
    },
  );
  assert.deepEqual(installedSdk(paths, sdk.manifest, sdk.key), {
    emulator: null,
    platformTools: "37.0.3",
    images: [],
    current: false,
  });
  assert.deepEqual(stages(paths), []);
  // The verified emulator archive waits in the download folder for the next call.
  sdk.fetchImpl.requests.length = 0;
  assert.equal((await install({ run: run(outputs) })).current, true);
  assert.equal(
    sdk.fetchImpl.requests[0].range,
    `bytes=${sdk.manifest.emulator.archives[sdk.key].size}-`,
  );
});

test("macOS runs no library check", async (t) => {
  const { sdk, install } = await fixture(t, { platform: "darwin-arm64" });
  const commands = [];
  const installed = await install({
    run: async (command, args) => {
      commands.push(path.basename(command));
      return args[0] === "version"
        ? "Version 37.0.3-1\n"
        : "Android emulator version 37.3.10.0 (build_id 16970787)\n";
    },
  });
  assert.deepEqual(commands, ["adb", "emulator"]);
  assert.deepEqual(installed.images, ["android-36-google_apis-r7"]);
  assert.ok(sdk.paths.image().endsWith("arm64-v8a"));
});

test("an archive that is not the pinned layout, or another host, is refused", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  // The archive unpacks below another top folder than the manifest names.
  const wrongTop = structuredClone(sdk.manifest);
  wrongTop.platformTools.archives[sdk.key].top = "tools";
  await assert.rejects(install({ manifest: wrongTop }), {
    code: "DEVICES_ARCHIVE_INVALID",
  });
  // More bytes than the manifest pins are not unpacked.
  const small = structuredClone(sdk.manifest);
  small.platformTools.archives[sdk.key].expandedBytes = 10;
  await assert.rejects(install({ manifest: small }), { code: "DEVICES_ARCHIVE_INVALID" });
  assert.equal(fs.existsSync(paths.platformTools), false);
  assert.deepEqual(stages(paths), []);
  // A download address outside the manifest's hosts is never asked.
  const elsewhere = structuredClone(sdk.manifest);
  elsewhere.hosts = ["downloads.example"];
  sdk.fetchImpl.requests.length = 0;
  await assert.rejects(install({ manifest: elsewhere }), {
    code: "DEVICES_DOWNLOAD_FAILED",
  });
  assert.deepEqual(sdk.fetchImpl.requests, []);
  // A platform the manifest does not pin has nothing to install.
  await assert.rejects(install({ key: "linux-arm64" }), {
    code: "DEVICES_PLATFORM_UNSUPPORTED",
  });
  // Anything unexpected is one stable code, not a raw error.
  await assert.rejects(
    install({
      unpack: async () => {
        throw Error("surprise");
      },
    }),
    { code: "DEVICES_ARCHIVE_INVALID" },
  );
});

test("removing the SDK leaves settings and devices alone", async (t) => {
  const { sdk, paths, install } = await fixture(t);
  await install();
  fs.writeFileSync(paths.settingsFile, "{}");
  fs.writeFileSync(paths.devicesFile, "{}");
  fs.writeFileSync(path.join(paths.avd, "d-000000000001.ini"), "x");
  fs.writeFileSync(path.join(paths.downloads, "a.zip.partial"), "x");
  await removeSdk(paths);
  assert.deepEqual(fs.readdirSync(paths.root).sort(), [
    "avd",
    "devices.json",
    "logs",
    "run",
    "settings.json",
  ]);
  assert.ok(fs.existsSync(path.join(paths.avd, "d-000000000001.ini")));
  assert.deepEqual(installedSdk(paths, sdk.manifest, sdk.key), {
    emulator: null,
    platformTools: null,
    images: [],
    current: false,
  });
  await removeSdk(paths);
});
