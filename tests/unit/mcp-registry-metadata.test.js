import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchRegistryJson,
  npmPackument,
  npmVersionInfo,
  npmVersions,
  pypiProject,
  pypiVersionInfo,
  pypiVersions,
  registryDownload,
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
        yanked: false,
      },
      {
        version: "1.1.0",
        publishedAt: "2026-03-01T00:00:00.000Z",
        prerelease: false,
        deprecated: false,
        yanked: false,
      },
      {
        version: "1.0.0",
        publishedAt: "2026-01-02T00:00:00.000Z",
        prerelease: false,
        deprecated: true,
        yanked: false,
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

const file = (filename, packagetype, sha256, at, extra = {}) => ({
  filename,
  url: `https://files.pythonhosted.org/${filename}`,
  digests: { sha256 },
  packagetype,
  upload_time_iso_8601: at,
  yanked: false,
  requires_python: ">=3.10",
  ...extra,
});
const project = {
  info: { version: "1.1" },
  releases: {
    "1.0": [
      file("x-1.0-py3-none-any.whl", "bdist_wheel", "a", "2026-01-01T00:00:00Z", {
        yanked: true,
      }),
    ],
    1.1: [file("x-1.1.tar.gz", "sdist", "b", "2026-02-01T00:00:00Z")],
    "2.0b1": [
      file("x-2.0b1-py3-none-any.whl", "bdist_wheel", "c", "2026-03-01T00:00:00Z"),
    ],
    0.9: [],
    "1.0-legacy": [file("x-legacy.tar.gz", "sdist", "d", "2025-01-01T00:00:00Z")],
  },
};
const entry = (version, publishedAt, prerelease, yanked) => ({
  version,
  publishedAt,
  prerelease,
  deprecated: false,
  yanked,
});

test("PyPI versions skip empty and non-PEP 440 releases and mark prereleases and yanked ones", () => {
  assert.deepEqual(pypiVersions(project), {
    latest: "1.1",
    versions: [
      entry("2.0b1", "2026-03-01T00:00:00Z", true, false),
      entry("1.1", "2026-02-01T00:00:00Z", false, false),
      entry("1.0", "2026-01-01T00:00:00Z", false, true),
    ],
  });
  assert.deepEqual(pypiVersionInfo(project, "1.1"), {
    files: [
      {
        filename: "x-1.1.tar.gz",
        url: "https://files.pythonhosted.org/x-1.1.tar.gz",
        sha256: "b",
        packagetype: "sdist",
        yanked: false,
      },
    ],
    requiresPython: ">=3.10",
  });
  // The same release under another spelling of its version (PEP 440 normalisation).
  assert.equal(pypiVersionInfo(project, "1.01").files[0].filename, "x-1.1.tar.gz");
  assert.equal(pypiVersionInfo(project, "1.0").files[0].yanked, true);
  assert.throws(() => pypiVersionInfo(project, "0.9"), {
    code: "MCP_PACKAGE_VERSION_NOT_FOUND",
  });
});

test("the PyPI project is read from the JSON API of the given registry", async () => {
  const urls = [];
  const download = async (url) => {
    urls.push(url);
    return Buffer.from(JSON.stringify(project));
  };
  assert.deepEqual(
    await pypiProject("x-y", { registry: "http://127.0.0.1:1", download }),
    project,
  );
  assert.deepEqual(urls, ["http://127.0.0.1:1/pypi/x-y/json"]);
});

const redirect = (location) => ({
  status: 302,
  ok: false,
  headers: new Headers({ location }),
  body: { cancel: async () => {} },
});
const notFound = { status: 404, ok: false, headers: new Headers(), body: null };

test("registry metadata follows redirects only on its own origin", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith("/a")) return redirect("https://registry.npmjs.org/b");
    if (url.endsWith("/b")) return notFound;
    if (url.endsWith("/d")) return redirect("http://registry.npmjs.org/b");
    return redirect("https://evil.example/x");
  };
  await assert.rejects(registryDownload("https://registry.npmjs.org/a", fetchImpl), {
    status: 404,
  });
  assert.deepEqual(seen, [
    "https://registry.npmjs.org/a",
    "https://registry.npmjs.org/b",
  ]);
  await assert.rejects(registryDownload("https://registry.npmjs.org/c", fetchImpl), {
    code: "DOWNLOAD_ORIGIN_CHANGED",
  });
  assert.equal(
    seen.some((url) => new URL(url).host === "evil.example"),
    false,
  );
  // A downgrade to http on the same host is refused before it is fetched.
  await assert.rejects(registryDownload("https://registry.npmjs.org/d", fetchImpl));
  assert.equal(
    seen.some((url) => new URL(url).protocol === "http:"),
    false,
  );
});

test("a scoped npm name keeps its @ and encodes its slash", async () => {
  const urls = [];
  await npmPackument("@scope/server-x", {
    registry: "https://registry.npmjs.org",
    download: async (url) => {
      urls.push(url);
      return Buffer.from("{}");
    },
  });
  assert.deepEqual(urls, ["https://registry.npmjs.org/@scope%2Fserver-x"]);
});

test("version info reads only own version keys", () => {
  const inherited = Object.create({ "1.0.0": { dist: { integrity: "sha512-x" } } });
  assert.throws(() => npmVersionInfo({ versions: inherited }, "1.0.0"), {
    code: "MCP_PACKAGE_VERSION_NOT_FOUND",
  });
  assert.throws(() => npmVersionInfo({ versions: {} }, "constructor"), {
    code: "MCP_PACKAGE_VERSION_NOT_FOUND",
  });
  assert.throws(() => npmVersionInfo({ versions: { "1.0.0": "text" } }, "1.0.0"), {
    code: "MCP_PACKAGE_VERSION_NOT_FOUND",
  });
});

test("PyPI versions with the same upload time sort by PEP 440", () => {
  const at = "2026-01-01T00:00:00Z";
  const listed = pypiVersions({
    info: { version: "1.0" },
    releases: {
      "1.0rc1": [file("a.whl", "bdist_wheel", "a", at)],
      "1.0": [file("b.whl", "bdist_wheel", "b", at)],
      "1.0.post1": [file("c.whl", "bdist_wheel", "c", at)],
    },
  }).versions.map((v) => v.version);
  assert.deepEqual(listed, ["1.0.post1", "1.0", "1.0rc1"]);
});

test("PyPI versions longer than 128 characters are not listed", () => {
  const long = `1.${"0".repeat(130)}`;
  const listed = pypiVersions({
    info: {},
    releases: { [long]: [file("a.whl", "bdist_wheel", "a", "2026-01-01T00:00:00Z")] },
  });
  assert.deepEqual(listed.versions, []);
});

test("another spelling longer than 128 characters is not the requested release", () => {
  // `1.000…0` reads as 1.0, but it is no version this service lists or stores.
  const long = `1.${"0".repeat(130)}`;
  const project = {
    info: {},
    releases: { [long]: [file("a.whl", "bdist_wheel", "a", "2026-01-01T00:00:00Z")] },
  };
  assert.throws(() => pypiVersionInfo(project, "1.0"), {
    code: "MCP_PACKAGE_VERSION_NOT_FOUND",
  });
});

test("a PyPI answer without releases is a registry failure, not an empty list", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  assert.throws(() => pypiVersions({ info: { version: "1.0" } }), {
    code: "MCP_PACKAGE_REGISTRY_UNAVAILABLE",
  });
  assert.throws(() => pypiVersionInfo({ info: {}, releases: [] }, "1.0"), {
    code: "MCP_PACKAGE_REGISTRY_UNAVAILABLE",
  });
  assert.match(String(errors.mock.calls[0].arguments[0]), /releases/);
});

test("pypiProject refuses a name that is not a PyPI name before any request", async () => {
  let requests = 0;
  const download = async () => {
    requests += 1;
    return Buffer.from("{}");
  };
  for (const name of ["../x", "a/b", "", "x".repeat(201)])
    await assert.rejects(pypiProject(name, { download }), {
      code: "MCP_PACKAGE_INVALID",
    });
  assert.equal(requests, 0);
});
