import test from "node:test";
import assert from "node:assert/strict";
import { releasePresentation } from "../../web/features/operations/release-presentation.js";

test("update presentation sorts semantic versions and separates stale staged receipts from actionable updates", () => {
  const releases = {
    current: "1.10.0",
    staged: [
      { id: "old", version: "1.9.0" },
      { id: "current", version: "1.10.0" },
      { id: "next", version: "1.11.0" },
      { id: "duplicate", version: "1.11.0" },
    ],
    releases: ["1.9.0", "1.10.0-rc.2", "1.10.0", "1.10.0-rc.10", "1.11.0", "1.9.0"].map(
      (version) => ({ version, canRollback: version !== "1.10.0-rc.2" }),
    ),
  };
  const result = releasePresentation(releases, { version: "1.11.0", upToDate: false });
  assert.deepEqual(result.staged, [{ id: "next", version: "1.11.0" }]);
  assert.equal(result.candidate, null);
  assert.deepEqual(
    result.history.map((item) => item.version),
    ["1.10.0-rc.10", "1.10.0-rc.2", "1.9.0"],
  );
  assert.equal(result.history[1].canRollback, false);
  assert.equal(releases.staged.length, 4);
});

test("current or older checked candidates never appear as new updates", () => {
  const releases = { current: "1.10.0", staged: [], releases: [] };
  assert.equal(
    releasePresentation(releases, { version: "1.9.0", upToDate: false }).candidate,
    null,
  );
  const plan = { version: "1.11.0-rc.1", upToDate: false };
  assert.equal(releasePresentation(releases, plan).candidate, plan);
});

test("malformed installed versions remain visible last and cannot activate or roll back", () => {
  const releases = {
    current: "1.10.0",
    staged: [{ id: "malformed", version: "1.0.0broken" }],
    releases: [
      { version: "1.0.0broken", canRollback: true, reason: "Incompatible" },
      { version: "1.9.0", canRollback: true },
    ],
  };
  const result = releasePresentation(releases, null);
  assert.deepEqual(result.staged, []);
  assert.deepEqual(
    result.history.map((item) => item.version),
    ["1.9.0", "1.0.0broken"],
  );
  assert.equal(result.history[1].canRollback, false);
  assert.equal(result.history[1].reason, "Incompatible");
});
