import test from "node:test";
import assert from "node:assert/strict";
import {
  newestStable,
  versionOptions,
} from "../../web/features/mcp-servers/mcp-package-versions.js";

const versions = [
  { version: "2.0.0-rc.1", prerelease: true, deprecated: false },
  { version: "1.2.0", prerelease: false, deprecated: true },
  { version: "1.1.0", prerelease: false, deprecated: false },
  { version: "1.0.0", prerelease: false, deprecated: false },
];

test("the newest stable version is preselected, not a prerelease latest tag", () => {
  assert.equal(newestStable({ latest: "1.1.0", versions }), "1.1.0");
  assert.equal(newestStable({ latest: "2.0.0-rc.1", versions }), "1.1.0");
  assert.equal(newestStable({ latest: null, versions }), "1.1.0");
  assert.equal(
    newestStable({ latest: null, versions: versions.slice(0, 2) }),
    "1.2.0",
    "a deprecated stable version beats a prerelease",
  );
  assert.equal(
    newestStable({ latest: null, versions: versions.slice(0, 1) }),
    "2.0.0-rc.1",
  );
  assert.equal(newestStable({ latest: null, versions: [] }), "");
});

test("prereleases stay hidden unless shown or selected; order is kept", () => {
  assert.deepEqual(
    versionOptions(versions, { showPrereleases: false, selected: "1.0.0" }).map(
      (v) => v.version,
    ),
    ["1.2.0", "1.1.0", "1.0.0"],
  );
  assert.deepEqual(
    versionOptions(versions, { showPrereleases: false, selected: "2.0.0-rc.1" }).map(
      (v) => v.version,
    ),
    ["2.0.0-rc.1", "1.2.0", "1.1.0", "1.0.0"],
  );
  assert.equal(versionOptions(versions, { showPrereleases: true }).length, 4);
});
