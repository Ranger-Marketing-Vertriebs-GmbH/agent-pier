import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setupFixture } from "../helpers/setup-fixture.js";
import { runInstaller } from "../../scripts/release-install.mjs";
import { installerArguments, resolveSetupOptions } from "../../scripts/setup-options.mjs";
import { readDeviceSettings } from "../../server/features/devices/device-settings.js";

// `--with-android-devices` from the entry points to the installer step
// (server/features/devices/device-provisioning.js), and the emulator's Linux
// libraries where Android devices are wanted.
const validate = (call) =>
  execFileSync("/bin/sh", ["-c", `. scripts/install-bootstrap.sh && ${call}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: "/Users/fixture" },
    stdio: ["ignore", "pipe", "pipe"],
  });
const x11 = ["libx11-6", "libx11-xcb1"];
// A Linux host whose dynamic linker knows neither X11 library; every tool is there.
function linuxHost() {
  const installs = [];
  return {
    installs,
    platform: "linux",
    run: async (command, args) => {
      if (command === "ldconfig")
        return { stdout: "\tlibc.so.6 => /lib/libc.so.6\n\tlibgomp.so.1 => /lib/x\n" };
      if (args.includes("install"))
        installs.push(args.slice(args.indexOf("install") + 2));
      return { stdout: "fixture", stderr: "OpenSSH_9.6p1" };
    },
  };
}

test("setup, both shell entry points and the installer arguments carry --with-android-devices", () => {
  const options = resolveSetupOptions(["--with-android-devices"], {
    home: "/Users/test",
    env: {},
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(options.withAndroidDevices, true);
  assert.ok(installerArguments(options, "1.2.3").includes("--with-android-devices"));
  validate(
    "validate_installer_options --install-root /a --data-dir /b --with-android-devices",
  );
  validate("validate_setup_options --with-android-devices");
  assert.throws(() =>
    validate("validate_setup_options --with-android-devices --dependencies-only"),
  );
  assert.throws(() =>
    validate("validate_installer_options --dependencies-only --with-android-devices"),
  );
  const help = execFileSync("/bin/sh", ["scripts/setup.sh", "--help"], {
    encoding: "utf8",
  });
  assert.match(help, /--with-android-devices .*Android devices.*terms/);
});

test("the first installation calls the step with enable and reports its result", async (t) => {
  const f = await setupFixture(t);
  const seen = [];
  const androidDevices = async (options) => (seen.push(options), { status: "requested" });
  const result = await runInstaller(
    [
      "--archive",
      f.options.archive,
      "--install-root",
      f.installRoot,
      "--data-dir",
      f.dataDir,
      "--with-android-devices",
    ],
    { ...f.dependencies, androidDevices },
  );
  assert.deepEqual(seen, [
    { dataDir: f.dataDir, enable: true, platform: process.platform },
  ]);
  assert.deepEqual(result.androidDevices, { status: "requested" });
});

test("a resumed setup calls the step too; without the flag and a request nothing is reported", async (t) => {
  const f = await setupFixture(t);
  const seen = [];
  const androidDevices = async (options) => (
    seen.push(options.enable),
    options.enable ? { status: "unavailable", message: "no KVM" } : null
  );
  const plain = await f.install({}, { androidDevices });
  assert.equal("androidDevices" in plain, false);
  // An unavailable host never fails the installation.
  const asked = await f.install({ withAndroidDevices: true }, { androidDevices });
  assert.deepEqual(asked.androidDevices, { status: "unavailable", message: "no KVM" });
  assert.deepEqual(seen, [false, true]);
  await assert.rejects(
    runInstaller(["--with-android-device"]),
    /Invalid installer option/,
  );
});

test("the real step stores the request in the installation's data folder", async (t) => {
  const f = await setupFixture(t);
  const messages = t.mock.method(console, "error", () => {});
  const result = await f.install({ withAndroidDevices: true });
  const supported =
    process.platform === "darwin"
      ? process.arch === "arm64"
      : process.platform === "linux" && process.arch === "x64";
  if (result.androidDevices.status === "requested") {
    assert.equal(supported, true);
    const settings = readDeviceSettings(f.dataDir);
    assert.deepEqual([settings.requested, settings.terms.by], [true, "installer"]);
    assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "devices")), ["settings.json"]);
    assert.match(
      messages.mock.calls.map((call) => call.arguments[0]).join("\n"),
      /Android Software Development Kit License Agreement/,
    );
    // The next run reports the pending request without the flag.
    assert.deepEqual((await f.install()).androidDevices, { status: "requested" });
  } else {
    // No emulator build, or Linux without usable KVM: said, and nothing written.
    assert.equal(result.androidDevices.status, "unavailable");
    assert.ok(result.androidDevices.message);
    assert.equal(fs.existsSync(path.join(f.dataDir, "devices")), false);
  }
});

test("Linux gets the emulator's libraries with the flag or a stored request, never otherwise", async (t) => {
  const androidDevices = async () => null;
  const wanted = process.arch === "x64" ? [x11] : [];
  // Without the flag and without a request: no X library on a headless server.
  const plain = await setupFixture(t);
  const none = linuxHost();
  await plain.install({ service: false }, { ...none, androidDevices });
  assert.deepEqual(none.installs, []);
  // With the flag.
  const flagged = await setupFixture(t);
  const first = linuxHost();
  await flagged.install(
    { service: false, withAndroidDevices: true },
    { ...first, androidDevices },
  );
  assert.deepEqual(first.installs, wanted);
  // With a request the owner or an earlier run left, on a later run without the flag.
  fs.mkdirSync(path.join(flagged.dataDir, "devices"), { recursive: true });
  fs.writeFileSync(
    path.join(flagged.dataDir, "devices", "settings.json"),
    JSON.stringify({ requested: true }),
  );
  const later = linuxHost();
  await flagged.install({ service: false }, { ...later, androidDevices });
  assert.deepEqual(later.installs, wanted);
  // The first installation passes the option on as well.
  const initial = await setupFixture(t);
  const fresh = linuxHost();
  await runInstaller(
    [
      "--archive",
      initial.options.archive,
      "--install-root",
      initial.installRoot,
      "--data-dir",
      initial.dataDir,
      "--with-android-devices",
    ],
    { ...initial.dependencies, ...fresh, androidDevices },
  );
  assert.deepEqual(fresh.installs, wanted);
});
