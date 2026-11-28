import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AVAILABILITY_CODES,
  hostProblem,
} from "../../server/features/devices/device-availability.js";

// Why a host cannot run Android devices at all (device-availability.js). The file
// system is injected: nothing here looks at this machine's /dev/kvm.
const never = () => {
  throw Error("not expected");
};

test("the three host codes are stable", () => {
  assert.deepEqual(AVAILABILITY_CODES, [
    "DEVICES_PLATFORM_UNSUPPORTED",
    "DEVICES_KVM_MISSING",
    "DEVICES_KVM_DENIED",
  ]);
  assert.ok(Object.isFrozen(AVAILABILITY_CODES));
});

test("macOS arm64 needs nothing beyond the platform", () => {
  assert.equal(
    hostProblem({ platform: "darwin", arch: "arm64", access: never, exists: never }),
    null,
  );
});

test("a platform without pinned archives is unsupported", () => {
  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ])
    assert.equal(
      hostProblem({ platform, arch, access: never, exists: never }),
      "DEVICES_PLATFORM_UNSUPPORTED",
    );
  // A manifest that pins nothing for a known platform leaves it unsupported too.
  const archives = { "linux-x64": {} };
  assert.equal(
    hostProblem({
      platform: "darwin",
      arch: "arm64",
      manifest: {
        emulator: { archives },
        platformTools: { archives },
        image: { archives },
      },
      access: never,
      exists: never,
    }),
    "DEVICES_PLATFORM_UNSUPPORTED",
  );
});

test("Linux x64 needs a /dev/kvm the service user may read and write", () => {
  const linux = { platform: "linux", arch: "x64" };
  const asked = [];
  assert.equal(
    hostProblem({
      ...linux,
      exists: (file) => (asked.push(file), false),
      access: never,
    }),
    "DEVICES_KVM_MISSING",
  );
  assert.equal(
    hostProblem({
      ...linux,
      exists: () => true,
      access: (file, mode) => {
        asked.push(file, mode);
        throw Object.assign(Error("EACCES"), { code: "EACCES" });
      },
    }),
    "DEVICES_KVM_DENIED",
  );
  assert.deepEqual(asked, [
    "/dev/kvm",
    "/dev/kvm",
    fs.constants.R_OK | fs.constants.W_OK,
  ]);
  assert.equal(hostProblem({ ...linux, exists: () => true, access: () => {} }), null);
});
