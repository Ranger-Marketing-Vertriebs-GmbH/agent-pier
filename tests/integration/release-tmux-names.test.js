import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";
import { Releases } from "../../server/features/operations/releases.js";
import { activateRelease } from "../../server/features/operations/release-activation.js";
import {
  requireTmuxNames,
  TMUX_NAMES_UNSUPPORTED,
} from "../../server/features/operations/release-schema.js";

const platform = `${process.platform}-${process.arch}`;

/**
 * An installation that runs a release producing `agentpier-<id>` sessions, beside
 * installed releases from before (no `tmuxNames`) and from step 1 of the rename
 * (understands both forms, still produces the former session names).
 */
async function installation(t) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-release-names-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "install"),
    dataDir = path.join(temp, "data");
  await fs.mkdir(dataDir);
  const install = async (version, extra = {}) => {
    await fs.mkdir(path.join(root, "releases", version), { recursive: true });
    await fs.writeFile(
      path.join(root, "releases", version, "release.json"),
      JSON.stringify({
        version,
        platform,
        schemaVersion: 1,
        schemaMin: 1,
        schemaMax: 2,
        ...extra,
      }),
    );
  };
  await install("2.4.0");
  await install("2.4.1", { tmuxNames: ["former"] });
  await install("2.5.0", { tmuxNames: ["former", "agentpier"] });
  await install("2.6.0", { tmuxNames: ["agentpier"] });
  await fs.symlink("releases/2.6.0", path.join(root, "current"));
  const releases = new Releases({ dataDir, installRoot: root, smoke: async () => {} });
  return { root, dataDir, releases };
}

test("a rollback to a release without agentpier in tmuxNames is refused", async (t) => {
  const { root, dataDir } = await installation(t);
  for (const version of ["2.4.0", "2.4.1"]) {
    await assert.rejects(
      activateRelease(
        { installRoot: root, dataDir, version },
        {
          restart: async () => assert.fail("must not restart a refused release"),
          health: async () => true,
        },
      ),
      {
        message: serverMessages.releases.tmuxNamesUnsupported,
        status: 409,
        code: TMUX_NAMES_UNSUPPORTED,
      },
      version,
    );
    assert.equal(await fs.readlink(path.join(root, "current")), "releases/2.6.0");
  }
});

test("a rollback to the release that understands both names is allowed", async (t) => {
  const { root, dataDir } = await installation(t);
  let restarts = 0;
  const result = await activateRelease(
    { installRoot: root, dataDir, version: "2.5.0" },
    { restart: async () => restarts++, health: async () => true },
  );
  assert.equal(result.activated, true);
  assert.equal(restarts, 1);
  assert.equal(await fs.readlink(path.join(root, "current")), "releases/2.5.0");
});

test("the release list shows a release without agentpier names as not rollbackable", async (t) => {
  const { releases } = await installation(t);
  const listed = Object.fromEntries(
    releases.status().releases.map((release) => [release.version, release]),
  );
  for (const version of ["2.4.0", "2.4.1"])
    assert.deepEqual(listed[version], {
      version,
      current: false,
      canRollback: false,
      reason: serverMessages.releases.tmuxNamesUnsupported,
    });
  assert.deepEqual(listed["2.5.0"], {
    version: "2.5.0",
    current: false,
    canRollback: true,
  });
  assert.equal(listed["2.6.0"].current, true);
});

test("the tmux name check reads only the manifest", () => {
  for (const tmuxNames of [undefined, null, "agentpier", [], ["former"], ["AgentPier"]])
    assert.throws(() => requireTmuxNames({ tmuxNames }), {
      message: serverMessages.releases.tmuxNamesUnsupported,
      code: TMUX_NAMES_UNSUPPORTED,
    });
  requireTmuxNames({ tmuxNames: ["former", "agentpier"] });
  for (const catalog of Object.values(serverCatalogs))
    assert.match(catalog.releases.tmuxNamesUnsupported, /agentpier/);
});
