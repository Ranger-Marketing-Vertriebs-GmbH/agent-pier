import assert from "node:assert/strict";
import path from "node:path";
import { applicationFixture } from "./application.js";
import { fakeAndroidSdk, freeDevicePorts, installFakeSdk } from "./fake-android-sdk.js";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * What `config.androidDevices` takes so that an application (or the wiring alone)
 * runs on the fake SDK `fake` with the loopback ports `ports`: the fake's manifest,
 * host and download host, no host problem, and fast boot checks.
 */
export const fakeDeviceOptions = (fake, ports, { source = {}, ...rest } = {}) => ({
  manifest: fake.manifest,
  host: fake.host,
  problem: () => null,
  fetchImpl: fake.fetchImpl,
  run: fake.run,
  source: { identity: fake.identity, pollMs: 20, killGraceMs: 2000, ...ports, ...source },
  ...rest,
});

/**
 * An application whose Android devices run on the fake SDK (fake-android-sdk.js) in
 * the application's own data folder, on loopback ports of the test's own. `installed`
 * puts the unpacked SDK there before the start; `options` are merged into
 * `config.androidDevices`. Returns `{ f, fake, ports, devices, sdk }`.
 *
 * When the test ends the application closes, and every process a fake recorded must
 * be gone by then; one that is not is killed and fails the test.
 */
export async function devicesApp(t, { installed = true, pairs = 2, options } = {}) {
  let fake = null;
  let f = null;
  // Registered before the application's own disposal, which removes the folder the
  // fakes record their processes in.
  t.after(async () => {
    const recorded = fake?.pids() ?? [];
    await f?.dispose();
    const left = recorded.filter(alive);
    for (const pid of left) process.kill(pid, "SIGKILL");
    assert.deepEqual(left, [], "a fake emulator or adb process outlived the application");
  });
  const ports = await freeDevicePorts(pairs);
  const android = {};
  f = await applicationFixture(t, {
    androidDevices: android,
    prepareDataDir: async (dataDir) => {
      fake = await fakeAndroidSdk({ root: path.dirname(dataDir) });
      assert.equal(fake.dataDir, dataDir);
      if (installed) await installFakeSdk(dataDir, fake.manifest);
      Object.assign(android, fakeDeviceOptions(fake, ports, options));
    },
  });
  return {
    f,
    fake,
    ports,
    devices: f.application.devices,
    sdk: f.application.androidSdk,
  };
}
