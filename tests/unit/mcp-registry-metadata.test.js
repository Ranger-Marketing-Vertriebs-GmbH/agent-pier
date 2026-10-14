import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchRegistryJson,
  npmVersionInfo,
  npmVersions,
} from "../../server/features/mcp-packages/registry-metadata.js";

const packument = {
  "dist-tags": { latest: "1.1.0" },
  time: {
    created: "2026-01-01T00:00:00.000Z",
    "1.0.0": "2026-01-02T00:00:00.000Z",
    "1.1.0": "2026-03-01T00:00:00.000Z",
    "2.0.0-rc.1": "2026-04-01T00:00:00.000Z",
  },
  versions: {
    "1.0.0": { dist: { integrity: "sha512-a" }, bin: "dist/index.js", deprecated: "old" },
    "1.1.0": {
      dist: { integrity: "sha512-b" },
      bin: { "server-x": "dist/index.js" },
      scripts: { postinstall: "node x" },
    },
    "2.0.0-rc.1": { dist: { integrity: "sha512-c" } },
  },
};

test("versions are newest first with prerelease and deprecated markers", () => {
  assert.deepEqual(npmVersions(packument), {
    latest: "1.1.0",
    versions: [
      {
        version: "2.0.0-rc.1",
        publishedAt: "2026-04-01T00:00:00.000Z",
        prerelease: true,
        deprecated: false,
      },
      {
        version: "1.1.0",
        publishedAt: "2026-03-01T00:00:00.000Z",
        prerelease: false,
        deprecated: false,
      },
      {
        version: "1.0.0",
        publishedAt: "2026-01-02T00:00:00.000Z",
        prerelease: false,
        deprecated: true,
      },
    ],
  });
});

test("versions without a publish time sort last and ties use semver order", () => {
  const order = npmVersions({
    time: {
      "1.9.0": "2026-02-01T00:00:00.000Z",
      "1.10.0": "2026-02-01T00:00:00.000Z",
      "1.10.0-rc.2": "2026-02-01T00:00:00.000Z",
      "1.10.0-rc.10": "2026-02-01T00:00:00.000Z",
    },
    versions: {
      "0.1.0": {},
      "1.9.0": {},
      "1.10.0": {},
      "1.10.0-rc.2": {},
      "1.10.0-rc.10": {},
      "0.2.0": {},
      "1.0.0+build-1": {},
    },
  }).versions;
  assert.deepEqual(
    order.map((entry) => entry.version),
    ["1.10.0", "1.10.0-rc.10", "1.10.0-rc.2", "1.9.0", "1.0.0+build-1", "0.2.0", "0.1.0"],
  );
  assert.deepEqual(
    order.map((entry) => entry.publishedAt === null),
    [false, false, false, false, true, true, true],
  );
});

test("build metadata with a hyphen is not a prerelease", () => {
  const [entry] = npmVersions({ versions: { "1.0.0+build-1": {} } }).versions;
  assert.equal(entry.prerelease, false);
  const [pre] = npmVersions({ versions: { "1.0.0-beta+build": {} } }).versions;
  assert.equal(pre.prerelease, true);
});

test("version info carries integrity, bin and install scripts", () => {
  assert.deepEqual(npmVersionInfo(packument, "1.1.0"), {
    integrity: "sha512-b",
    bin: { "server-x": "dist/index.js" },
    installScripts: true,
  });
  assert.throws(() => npmVersionInfo(packument, "9.9.9"), {
    code: "MCP_PACKAGE_VERSION_NOT_FOUND",
  });
});

test("registry failures map to stable codes", async () => {
  const fail = (status) => async () => {
    throw Object.assign(Error("x"), { status });
  };
  await assert.rejects(fetchRegistryJson("https://r/x", { download: fail(404) }), {
    code: "MCP_PACKAGE_NOT_FOUND",
  });
  await assert.rejects(fetchRegistryJson("https://r/x", { download: fail(502) }), {
    code: "MCP_PACKAGE_REGISTRY_UNAVAILABLE",
  });
  await assert.rejects(
    fetchRegistryJson("https://r/x", { download: async () => Buffer.from("{") }),
    { code: "MCP_PACKAGE_REGISTRY_UNAVAILABLE" },
  );
});
