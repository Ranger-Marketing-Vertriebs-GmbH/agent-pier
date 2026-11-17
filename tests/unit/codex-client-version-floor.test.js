import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertCodexClientVersionFloor,
  codexClientVersionFloor,
  compareVersions,
} from "../helpers/codex-client-version-floor.js";
import { applyBundlePatches } from "../../server/features/assistants/runtimes/openclaw/runtime-bundle-patches.js";

const constant = (version) => `const OPENAI_CODEX_CLIENT_VERSION = "${version}";\n`;

// A package whose dist holds `files` ({ relative path: text }).
function packageDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-client-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test("versions compare numerically", () => {
  assert.equal(compareVersions("0.169.0", "0.169.0"), 0);
  assert.equal(compareVersions("0.164.0", "0.169.0"), -1);
  assert.equal(compareVersions("0.170.0", "0.169.0"), 1);
  assert.equal(compareVersions("1.0.0", "0.999.9"), 1);
  assert.equal(compareVersions("0.169.10", "0.169.9"), 1);
});

test("a package at or above the floor passes", (t) => {
  const dir = packageDir(t, {
    "dist/base-url-X.mjs": constant(codexClientVersionFloor),
    "dist/extensions/openai/.setup/policy.mjs": constant("0.170.1"),
  });
  assert.equal(assertCodexClientVersionFloor(dir).length, 2);
});

test("an older constant or a literal client_version query fails", (t) => {
  const old = packageDir(t, {
    "dist/base-url-X.mjs": constant("0.169.0"),
    "dist/extensions/openai/.setup/policy.mjs": constant("0.164.0"),
  });
  assert.throws(
    () => assertCodexClientVersionFloor(old),
    /policy\.mjs \(0\.164\.0\).*codex-catalog-client-version/,
  );
  const literal = packageDir(t, {
    "dist/base-url-X.mjs": constant("0.169.0"),
    "dist/models.js": "fetch(`${base}/models?client_version=0.160.0`);\n",
  });
  assert.throws(() => assertCodexClientVersionFloor(literal), /models\.js \(0\.160\.0\)/);
});

test("a package without the constant fails instead of passing silently", (t) => {
  const dir = packageDir(t, { "dist/other.mjs": "export const x = 1;\n" });
  assert.throws(
    () => assertCodexClientVersionFloor(dir),
    /No OPENAI_CODEX_CLIENT_VERSION/,
  );
});

test("the pinned version's patches lift 2026.11.3's constants over the floor", (t) => {
  const files = {
    "dist/openclaw-state-lease-heartbeat-shared-BczGehzh.mjs":
      "const LEASE_CONTENTION_RETRY_TIMEOUT_MS = 2e3;\n",
    "dist/base-url-Baro1bPi.mjs": constant("0.164.0"),
    "dist/extensions/openai/.setup/provider-policy-api-BhWaBu5H.mjs": constant("0.164.0"),
  };
  const dir = packageDir(t, files);
  assert.throws(() => assertCodexClientVersionFloor(dir));
  applyBundlePatches(dir, "2026.11.3");
  assert.equal(assertCodexClientVersionFloor(dir).length, 2);
});
