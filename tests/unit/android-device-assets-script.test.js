import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  archiveFetch,
  deviceFeaturePaths,
  fetchDeviceAssets,
  fetchFailureIsFatal,
} from "../../scripts/android-device-assets.mjs";
import { globPattern } from "../../scripts/assistant-runtime-paths.mjs";
import { fakeAndroidSdk } from "../helpers/fake-android-sdk.js";
import { installedSdk } from "../../server/features/devices/android-sdk-install.js";

// How CI gets the pinned Android SDK for the device contract
// (scripts/android-device-assets.mjs, .github/workflows/android-devices.yml): an
// outage of the download host never fails an unrelated run, and never lets a change
// of the feature pass unseen.
const root = path.resolve(import.meta.dirname, "../..");
const workflow = (name) =>
  YAML.parse(fs.readFileSync(path.join(root, ".github/workflows", name), "utf8"));
const base = "a".repeat(40);
const featureFiles = [
  "server/features/devices/emulator-source.js",
  "server/features/devices/android-manifest.js",
  "server/features/tools/pinned-download.js",
  "server/features/tools/zip-unpack.js",
  "scripts/android-device-assets.mjs",
  "tests/integration/android-devices-contract.test.js",
  ".github/workflows/android-devices.yml",
];

test("only a pull request that changes the feature fails on a fetch failure", () => {
  const fatal = (changed, from = base) => fetchFailureIsFatal({ base: from, changed });
  for (const file of featureFiles) assert.equal(fatal(["README.md", file]), true, file);
  assert.equal(fatal(["server/features/previews/preview-service.js"]), false);
  assert.equal(fatal([]), false);
  // Changes that cannot be read count as a change of the feature.
  assert.equal(fatal(null), true);
  // Nightly, release and on demand have no base: the contract is left out, visibly.
  assert.equal(fatal(null, ""), false);
  assert.equal(fatal(["scripts/android-device-assets.mjs"], ""), false);
});

test("a failed installation is an annotation with its stable code", async () => {
  const calls = [];
  const lines = [];
  const options = (fail, changed) => ({
    ensure: async ({ paths, key, fetchImpl }) => {
      calls.push([paths.sdk, key, typeof fetchImpl]);
      if (fail)
        throw Object.assign(Error("/a/path"), { code: "DEVICES_DOWNLOAD_FAILED" });
    },
    changed: () => changed,
    log: (line) => lines.push(line),
    host: { platform: "linux", arch: "x64" },
  });
  assert.deepEqual(
    await fetchDeviceAssets({ root: "/r", base, archives: "/zips" }, options(false)),
    { available: true },
  );
  assert.deepEqual(calls, [["/r/devices/sdk", "linux-x64", "function"]]);
  let result = await fetchDeviceAssets({ root: "/r", base }, options(true, ["docs/x"]));
  assert.deepEqual(result, {
    available: false,
    fatal: false,
    code: "DEVICES_DOWNLOAD_FAILED",
  });
  assert.equal(calls[1][2], "undefined");
  assert.match(lines[0], /^::warning title=Android device contract not run::/);
  assert.match(lines[0], /DEVICES_DOWNLOAD_FAILED/);
  assert.doesNotMatch(lines[0], /\/a\/path/);
  result = await fetchDeviceAssets({ root: "/r", base }, options(true, featureFiles));
  assert.equal(result.fatal, true);
  assert.match(lines[1], /^::error title=Android SDK unavailable::/);
});

test("archives in a local folder are installed without the network, by their pins", async (t) => {
  const sdk = await fakeAndroidSdk();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "android-archives-"));
  t.after(async () => {
    await sdk.cleanup();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  // The archives as a download left them, named as in their URLs.
  const archives = ["emulator", "platformTools", "image"].map(
    (name) => sdk.manifest[name].archives[sdk.key],
  );
  for (const archive of archives) {
    const response = await sdk.fetchImpl(archive.url);
    fs.writeFileSync(
      path.join(folder, path.basename(archive.url)),
      Buffer.from(await response.arrayBuffer()),
    );
  }
  const network = [];
  const offline = async (url) => {
    network.push(url);
    return new Response("no network", { status: 503 });
  };
  const local = archiveFetch(folder, offline);
  // A whole file, a range of it, and a range with nothing left.
  const [{ url, size }] = archives;
  assert.equal((await (await local(url)).arrayBuffer()).byteLength, size);
  const part = await local(url, { headers: { range: `bytes=${size - 10}-` } });
  assert.equal(part.status, 206);
  assert.equal(
    part.headers.get("content-range"),
    `bytes ${size - 10}-${size - 1}/${size}`,
  );
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal((await local(url, { headers: { range: `bytes=${size}-` } })).status, 416);
  assert.equal((await local(`${url}.other`)).status, 503);
  assert.deepEqual(network, [`${url}.other`]);

  const original = globalThis.fetch;
  globalThis.fetch = offline;
  t.after(() => (globalThis.fetch = original));
  const lines = [];
  const options = {
    manifest: sdk.manifest,
    host: sdk.host,
    log: (line) => lines.push(line),
  };
  assert.deepEqual(
    await fetchDeviceAssets({ root: sdk.dataDir, archives: folder }, options),
    { available: true },
  );
  assert.equal(installedSdk(sdk.paths, sdk.manifest, sdk.key).current, true);
  assert.equal(network.length, 1);
  // An archive that is not the pinned one is refused, wherever it comes from.
  const other = await fakeAndroidSdk();
  t.after(() => other.cleanup());
  const first = path.join(folder, path.basename(archives[1].url));
  fs.writeFileSync(first, Buffer.concat([fs.readFileSync(first), Buffer.from("x")]));
  const refused = await fetchDeviceAssets(
    { root: other.dataDir, archives: folder },
    { ...options, manifest: sdk.manifest, host: other.host },
  );
  assert.equal(refused.available, false);
  assert.equal(refused.code, "DEVICES_CHECKSUM_MISMATCH");
  assert.equal(installedSdk(other.paths, sdk.manifest, other.key).current, false);
});

test("the contract job has KVM, the emulator's libraries and the SDK cached by its pins", () => {
  const { steps } = workflow("android-devices.yml").jobs.contract;
  const index = (pattern) => steps.findIndex((step) => pattern.test(step.run || ""));
  const kvm = steps[index(/udev/)];
  assert.match(
    kvm.run,
    /KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS\+="static_node=kvm"/,
  );
  assert.match(kvm.run, /99-kvm4all\.rules/);
  assert.match(kvm.run, /udevadm control --reload-rules/);
  assert.match(kvm.run, /udevadm trigger --name-match=kvm/);
  assert.match(steps[index(/apt-get install/)].run, /libx11-6 libx11-xcb1$/m);
  const cache = steps.find((step) => step.uses?.startsWith("actions/cache@"));
  assert.match(cache.with.path, /agentpier-android-contract\/devices\/sdk$/);
  assert.match(cache.with.key, /runner\.os.*runner\.arch.*steps\.sdk\.outputs\.identity/);
  const identity = steps.find((step) => step.id === "sdk").run;
  for (const pin of ["emulator.build", "platformTools.version", "image.id"])
    assert.ok(identity.includes(pin), pin);
  const assets = steps.find((step) => step.id === "assets");
  assert.match(assets.run, /android-device-assets\.mjs/);
  assert.match(assets.run, /--root "\$RUNNER_TEMP\/agentpier-android-contract"/);
  assert.match(assets.run, /--base "\$BASE_SHA"/);
  const contract = steps[index(/android-devices-contract\.test\.js/)];
  assert.equal(contract.if, "steps.assets.outputs.available == 'true'");
  // On the runner a missing prerequisite fails; it does not skip.
  assert.equal(contract.env.AGENTPIER_ANDROID_CONTRACT_REQUIRED, "1");
  assert.match(
    contract.run,
    /AGENTPIER_ANDROID_CONTRACT_SDK="\$RUNNER_TEMP\/agentpier-android-contract"/,
  );
  for (const before of [/udev/, /apt-get install/, /android-device-assets/])
    assert.ok(index(before) < steps.indexOf(contract));
  assert.equal(workflow("android-devices.yml").jobs.contract["runs-on"], "ubuntu-24.04");
});

test("pull requests that touch the feature run the contract, and so does the nightly", () => {
  const devices = workflow("android-devices.yml");
  assert.deepEqual(Object.keys(devices.on).sort(), [
    "pull_request",
    "workflow_call",
    "workflow_dispatch",
  ]);
  const patterns = devices.on.pull_request.paths.map(globPattern);
  for (const file of [...featureFiles, "server/features/devices/device-service.js"])
    assert.ok(
      patterns.some((pattern) => pattern.test(file)),
      file,
    );
  // Whatever makes a fetch failure fatal also triggers the workflow.
  for (const file of featureFiles)
    assert.ok(
      deviceFeaturePaths.some((pattern) => pattern.test(file)),
      file,
    );
  assert.equal(
    patterns.some((pattern) => pattern.test("web/features/devices/x.jsx")),
    false,
  );
  const full = workflow("full.yml");
  assert.equal(
    full.jobs["android-devices"].uses,
    "./.github/workflows/android-devices.yml",
  );
  assert.ok(full.jobs.result.needs.includes("android-devices"));
});
