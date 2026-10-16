import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  defaultBaseUrl,
  directorySettings,
  isLoopbackHost,
  normaliseBaseUrl,
} from "../../server/features/mcp-directory/directory-settings.js";

test("https bases are stored without a trailing slash and keep their path", () => {
  assert.equal(
    normaliseBaseUrl("https://registry.example.test/"),
    "https://registry.example.test",
  );
  assert.equal(
    normaliseBaseUrl(" https://registry.example.test/mirror/ "),
    "https://registry.example.test/mirror",
  );
  assert.equal(
    normaliseBaseUrl("HTTPS://Registry.Example.Test"),
    "https://registry.example.test",
  );
});

test("plain http is allowed on loopback hosts only", () => {
  assert.equal(normaliseBaseUrl("http://127.0.0.1:8123"), "http://127.0.0.1:8123");
  assert.equal(normaliseBaseUrl("http://localhost:8123/"), "http://localhost:8123");
  assert.equal(normaliseBaseUrl("http://[::1]:8123"), "http://[::1]:8123");
  for (const host of ["localhost", "127.0.0.1", "127.8.9.1", "[::1]"])
    assert.equal(isLoopbackHost(host), true);
  for (const host of ["example.test", "10.0.0.1", "0.0.0.0", "localhost.example.test"])
    assert.equal(isLoopbackHost(host), false, host);
});

test("credentials, queries, fragments, other schemes and long values are refused", () => {
  for (const value of [
    "http://registry.example.test",
    "https://user:pw@registry.example.test",
    "https://registry.example.test/?x=1",
    "https://registry.example.test/?",
    "https://registry.example.test/#x",
    "ftp://registry.example.test",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "",
    "registry.example.test",
    `https://example.test/${"a".repeat(520)}`,
    42,
    null,
  ])
    assert.throws(
      () => normaliseBaseUrl(value),
      (error) => error.code === "MCP_DIRECTORY_INVALID_SETTINGS",
      String(value),
    );
});

test("saved settings fall back to defaults when unreadable", () => {
  assert.deepEqual(directorySettings(undefined), {
    enabled: true,
    baseUrl: defaultBaseUrl,
  });
  assert.deepEqual(directorySettings({ enabled: false }), {
    enabled: false,
    baseUrl: defaultBaseUrl,
  });
  assert.deepEqual(directorySettings({ enabled: "no", baseUrl: "ftp://x" }), {
    enabled: true,
    baseUrl: defaultBaseUrl,
  });
  fc.assert(
    fc.property(fc.anything(), (saved) => {
      const settings = directorySettings(saved);
      assert.equal(typeof settings.enabled, "boolean");
      assert.doesNotThrow(() => normaliseBaseUrl(settings.baseUrl));
    }),
  );
});
