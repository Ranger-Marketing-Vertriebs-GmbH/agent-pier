import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  craftBinary,
  craftBinaryPath,
  craftManifest,
  craftPlatform,
} from "../../server/features/tools/craft-manifest.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

test("every platform pins an https github release asset with sha256", () => {
  assert.equal(craftManifest.version, "0.5.0");
  assert.deepEqual(Object.keys(craftManifest.platforms).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
  ]);
  for (const entry of Object.values(craftManifest.platforms)) {
    assert.match(
      entry.url,
      /^https:\/\/github\.com\/storytold\/craft-anything\/releases\/download\/v0\.5\.0\//,
    );
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.size > 0 && entry.installedSize > 0);
  }
});

test("darwin x64 and arm64 share the universal zip", () => {
  const { "darwin-arm64": arm, "darwin-x64": x64 } = craftManifest.platforms;
  assert.equal(arm, x64);
  assert.equal(arm.kind, "zip");
  assert.equal(arm.binary, "craft-anything-cli");
});

test("linux entries drop the GUI binary", () => {
  for (const key of ["linux-x64", "linux-arm64"]) {
    const entry = craftManifest.platforms[key];
    assert.equal(entry.binary, "bin/craft-anything-cli");
    assert.deepEqual(entry.remove, ["bin/craft-anything"]);
  }
});

test("craftPlatform refuses win32 and freebsd with platformUnavailable", () => {
  for (const platform of ["win32", "freebsd"]) {
    const result = craftPlatform({ platform, arch: "x64" });
    assert.equal(result.available, false);
    assert.equal(result.entry, null);
    assert.equal(result.reason, serverMessages.craft.platformUnavailable);
  }
  const ok = craftPlatform({ platform: "linux", arch: "arm64" });
  assert.equal(ok.available, true);
  assert.equal(ok.entry, craftManifest.platforms["linux-arm64"]);
  assert.equal(craftPlatform({ platform: "linux", arch: "ia32" }).available, false);
});

test("binary paths", () => {
  assert.equal(
    craftBinaryPath("/r", craftManifest.platforms["linux-x64"]),
    "/r/craft-anything/craft-anything-0.5.0-linux-x86_64/bin/craft-anything-cli",
  );
  assert.equal(
    craftBinaryPath("/r", craftManifest.platforms["darwin-arm64"]),
    "/r/craft-anything/craft-anything-cli-0.5.0-macos-universal/craft-anything-cli",
  );
  assert.equal(
    craftBinary({ home: "/h/bin" }),
    path.join("/h/bin", "craft-anything-cli"),
  );
});
