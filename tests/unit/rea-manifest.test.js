import test from "node:test";
import assert from "node:assert/strict";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { checkNpmLock } from "../../server/features/mcp-packages/lock-check.js";
import { npmManifestText } from "../../server/features/mcp-packages/npm-package-install.js";
import { reaSources } from "../../server/features/tools/verified-download.js";
import {
  reaCore,
  reaManifest,
  reaPlatform,
} from "../../server/features/tools/rea-manifest.js";

const mac = (darwinMajor, arch = "arm64") => ({ platform: "darwin", arch, darwinMajor });

test("darwin-arm64 on macOS 15 picks the sequoia bottle, 26 and newer the tahoe bottle", () => {
  const sequoia = reaPlatform(mac(24));
  assert.equal(sequoia.key, "darwin-arm64");
  assert.equal(sequoia.available, true);
  assert.equal(sequoia.core, true);
  assert.equal(sequoia.ghidra.entry.name, "arm64_sequoia");
  assert.equal(sequoia.ghidra.entry.kind, "tar.gz");
  assert.equal(sequoia.ghidra.entry.installDir, "ghidra/12.1.4/libexec");
  assert.equal(sequoia.ghidra.entry.auth, "ghcr-anonymous");
  assert.equal(
    sequoia.ghidra.entry.sha256,
    "fdaf330d5d9e3a2ad7c58c4cf69c6a145ec8a964c119617d6476f911434d6ca2",
  );
  assert.equal(sequoia.ghidra.entry.size, 464278484);
  assert.equal(sequoia.ghidra.entry.minDarwin, undefined);
  assert.equal(sequoia.ghidra.jdk.home, "jdk-21.0.13+9/Contents/Home");
  assert.equal(sequoia.ghidraReason, null);
  assert.equal(sequoia.frida.size, 38219481);
  assert.equal(sequoia.fridaReason, null);
  for (const major of [25, 30]) {
    const tahoe = reaPlatform(mac(major));
    assert.equal(tahoe.ghidra.entry.name, "arm64_tahoe");
    assert.equal(
      tahoe.ghidra.entry.sha256,
      "d2a6222389d18d32d48e55079407c1d877d90f86d692911b0399a6ff5e440a9a",
    );
  }
  const old = reaPlatform(mac(23));
  assert.equal(old.available, true);
  assert.equal(old.core, true);
  assert.equal(old.ghidra, null);
  assert.equal(old.ghidraReason, serverMessages.rea.ghidraMacosTooOld);
  assert.ok(old.frida);
  // An unknown macOS version cannot pick a bottle either.
  assert.equal(reaPlatform(mac(Number.NaN)).ghidra, null);
});

test("linux-x64 gets the official zip; linux-arm64 and Intel Macs get Core and a Ghidra reason", () => {
  const linux = reaPlatform({ platform: "linux", arch: "x64" });
  assert.equal(linux.key, "linux-x64");
  assert.equal(linux.available, true);
  assert.equal(linux.ghidra.entry.kind, "zip");
  assert.equal(linux.ghidra.entry.top, "ghidra_12.1.4_PUBLIC");
  assert.equal(
    linux.ghidra.entry.decompiler,
    "Ghidra/Features/Decompiler/os/linux_x86_64/decompile",
  );
  assert.equal(linux.ghidra.entry.auth, undefined);
  assert.equal(linux.ghidra.jdk.home, "jdk-21.0.13+9");
  assert.ok(linux.frida);

  for (const [host, reason] of [
    [{ platform: "linux", arch: "arm64" }, serverMessages.rea.ghidraLinuxArm64],
    [mac(25, "x64"), serverMessages.rea.ghidraIntelMac],
  ]) {
    const result = reaPlatform(host);
    assert.equal(result.available, true);
    assert.equal(result.core, true);
    assert.equal(result.reason, null);
    assert.equal(result.ghidra, null);
    assert.equal(result.ghidraReason, reason);
    assert.ok(result.frida, `${result.key} has a frida prebuild`);
    assert.equal(result.fridaReason, null);
  }
});

test("win32 and other arches are unavailable", () => {
  for (const host of [
    { platform: "win32", arch: "x64" },
    { platform: "linux", arch: "ia32" },
    { platform: "darwin", arch: "ppc", darwinMajor: 25 },
    { platform: "freebsd", arch: "x64" },
  ]) {
    const result = reaPlatform(host);
    assert.equal(result.key, null);
    assert.equal(result.available, false);
    assert.equal(result.reason, serverMessages.rea.platformUnavailable);
    assert.equal(result.core, false);
    assert.equal(result.ghidra, null);
    assert.equal(result.frida, null);
  }
});

test("a platform without a frida prebuild keeps Core and names the reason", () => {
  const manifest = structuredClone(reaManifest);
  delete manifest.frida.platforms["linux-x64"];
  const result = reaPlatform({ platform: "linux", arch: "x64" }, manifest);
  assert.equal(result.frida, null);
  assert.equal(result.fridaReason, serverMessages.rea.fridaUnavailable);
  assert.ok(result.ghidra);
});

function downloads(manifest) {
  const entries = [];
  for (const platform of Object.values(manifest.ghidra.platforms))
    for (const variant of platform.variants ?? [platform]) entries.push(variant);
  entries.push(...Object.values(manifest.jdk.platforms));
  entries.push(...Object.values(manifest.frida.platforms));
  return entries;
}

test("every pinned download is https, on an allowed source, with a 64-hex SHA-256 and a size", () => {
  const entries = downloads(reaManifest);
  assert.equal(entries.length, 2 + 1 + 2 + 4);
  for (const entry of entries) {
    const url = new URL(entry.url);
    assert.equal(url.protocol, "https:", entry.url);
    assert.ok(Object.hasOwn(reaSources, url.hostname), entry.url);
    const prefixes = reaSources[url.hostname];
    assert.ok(Array.isArray(prefixes), `${entry.url} starts on a path-checked host`);
    assert.ok(
      prefixes.some((prefix) => url.pathname.startsWith(prefix)),
      entry.url,
    );
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0, entry.url);
    if (url.hostname === "ghcr.io")
      assert.equal(url.pathname.split(":").at(-1), entry.sha256);
  }
  for (const entry of [
    ...Object.values(reaManifest.ghidra.platforms),
    ...Object.values(reaManifest.jdk.platforms),
  ])
    assert.ok(Number.isSafeInteger(entry.installedSize) && entry.installedSize > 0);
  for (const key of Object.keys(reaManifest.frida.platforms))
    assert.ok(
      reaManifest.frida.platforms[key].url.endsWith(
        `/frida-v${reaManifest.frida.version}-napi-v${reaManifest.frida.napi}-${key}.tar.gz`,
      ),
    );
});

test("the committed lock passes the npm lock check for rea-agents 6.8.0", () => {
  const core = reaCore();
  const { ref, lockText, integrity } = core;
  assert.deepEqual(ref, { registry: "npm", name: "rea-agents", version: "6.8.0" });
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.deepEqual(core.program, { name: "rea", path: "scripts/rea.mjs" });
  assert.deepEqual(core.args, ["mcp"]);
  const checked = checkNpmLock(lockText, {
    ref,
    integrity,
    registry: "https://registry.npmjs.org",
  });
  const lock = JSON.parse(lockText);
  assert.equal(lock.packages[""].dependencies["rea-agents"], "6.8.0");
  assert.equal(lock.packages["node_modules/frida"].version, "17.23.2");
  // frida's install script exists and is never run: the prebuild replaces it.
  assert.equal(checked.needsScripts, true);
});

test("the lock matches the manifest text npm ci expects", () => {
  const { ref, lockText } = reaCore();
  const lock = JSON.parse(lockText);
  const manifest = JSON.parse(npmManifestText(ref));
  assert.deepEqual(manifest.dependencies, lock.packages[""].dependencies);
  assert.equal(lock.packages[""].name, manifest.name);
});
