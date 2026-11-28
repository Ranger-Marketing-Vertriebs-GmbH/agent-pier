import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEVICE_LIMITS,
  readDeviceSettings,
  writeDeviceSettings,
} from "../../server/features/devices/device-settings.js";

// The owner's device limits and the installation record (device-settings.js).
const tmp = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "device-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const defaults = {
  maxDevices: 5,
  maxRunning: 2,
  requested: false,
  terms: null,
  failure: null,
  operation: null,
};
const invalid = { code: "DEVICES_SETTINGS_INVALID", status: 400 };

test("without a file the settings are the defaults", (t) => {
  const dataDir = tmp(t);
  assert.deepEqual(DEVICE_LIMITS, {
    maxDevices: { default: 5, min: 1, max: 20 },
    maxRunning: { default: 2, min: 1, max: 5 },
  });
  assert.deepEqual(readDeviceSettings(dataDir), defaults);
  // Reading creates nothing.
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

test("a patch is merged and stored privately", (t) => {
  const dataDir = tmp(t);
  assert.deepEqual(writeDeviceSettings(dataDir, { maxDevices: 20, maxRunning: 1 }), {
    ...defaults,
    maxDevices: 20,
    maxRunning: 1,
  });
  const terms = {
    acceptedAt: 1795000000000,
    by: "installer",
    versions: { emulator: "37.3.10", platformTools: "37.0.3", image: "android-36" },
  };
  writeDeviceSettings(dataDir, { requested: true, terms });
  writeDeviceSettings(dataDir, {
    failure: {
      code: "DEVICES_SDK_UNUSABLE",
      at: 5,
      detail: { missing: ["libX11.so.6"] },
    },
    operation: { kind: "install", startedAt: 4 },
  });
  assert.deepEqual(readDeviceSettings(dataDir), {
    maxDevices: 20,
    maxRunning: 1,
    requested: true,
    terms,
    failure: {
      code: "DEVICES_SDK_UNUSABLE",
      at: 5,
      detail: { missing: ["libX11.so.6"] },
    },
    operation: { kind: "install", startedAt: 4 },
  });
  const file = path.join(dataDir, "devices", "settings.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["settings.json"]);
});

test("values outside the bounds and unknown fields are refused and not stored", (t) => {
  const dataDir = tmp(t);
  writeDeviceSettings(dataDir, { maxDevices: 3 });
  for (const patch of [
    { maxDevices: 0 },
    { maxDevices: 21 },
    { maxDevices: 2.5 },
    { maxDevices: "5" },
    { maxRunning: 0 },
    { maxRunning: 6 },
    { maxRunning: null },
    { requested: "yes" },
    { terms: { by: "someone", acceptedAt: 1, versions: {} } },
    { failure: { code: "", at: 1 } },
    { operation: { kind: "update", startedAt: 1 } },
    { maxDevices: 4, unknown: true },
    null,
    [],
  ])
    assert.throws(
      () => writeDeviceSettings(dataDir, patch),
      invalid,
      JSON.stringify(patch),
    );
  assert.deepEqual(readDeviceSettings(dataDir), { ...defaults, maxDevices: 3 });
  for (const patch of [{ maxDevices: 1 }, { maxDevices: 20 }, { maxRunning: 5 }])
    writeDeviceSettings(dataDir, patch);
  assert.deepEqual(readDeviceSettings(dataDir), {
    ...defaults,
    maxDevices: 20,
    maxRunning: 5,
  });
});

test("a damaged file reads as the defaults, field by field", (t) => {
  const dataDir = tmp(t);
  const file = path.join(dataDir, "devices", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const content of ["{ not json", "[]", "null", '"text"', ""]) {
    fs.writeFileSync(file, content);
    assert.deepEqual(readDeviceSettings(dataDir), defaults, content);
  }
  // One bad value does not take the good ones with it.
  fs.writeFileSync(file, JSON.stringify({ maxDevices: 99, maxRunning: 4, requested: 1 }));
  assert.deepEqual(readDeviceSettings(dataDir), { ...defaults, maxRunning: 4 });
  // And the next write repairs the file.
  writeDeviceSettings(dataDir, { maxDevices: 7 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    ...defaults,
    maxDevices: 7,
    maxRunning: 4,
  });
});
