import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Releases } from "../../server/features/operations/releases.js";

const official =
  "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/latest/download/";
async function fixture(t, current = "1.5.1", version = "1.6.0", options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-channel-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, "data");
  const installRoot = path.join(temp, "install");
  await fs.mkdir(dataDir);
  await fs.mkdir(path.join(installRoot, "current"), { recursive: true });
  await fs.writeFile(
    path.join(installRoot, "current/release.json"),
    JSON.stringify({ version: current }),
  );
  return new Releases({
    dataDir,
    installRoot,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          version,
          schemaVersion: 1,
          artifacts: {
            [`${process.platform}-${process.arch}`]: {
              file: "release.aprelease",
              sha256: "a".repeat(64),
            },
          },
        }),
      ),
    ...options,
  });
}
test("release checks use the official public GitHub channel by default", async (t) => {
  const releases = await fixture(t, undefined, undefined, { channel: "" });
  assert.equal(releases.status().channel, official);
  const plan = await releases.check();
  assert.equal(plan.version, "1.6.0");
  assert.equal(plan.upToDate, false);
});
test("release checks preserve explicit custom channels", async (t) => {
  const releases = await fixture(t, undefined, undefined, {
    channel: "https://custom.example/releases/",
  });
  assert.equal(releases.status().channel, "https://custom.example/releases/");
});
test("missing release manifests produce an actionable no-release message", async (t) => {
  const releases = await fixture(t, undefined, undefined, {
    channel: official,
    fetchImpl: async () => new Response("Not Found", { status: 404 }),
  });
  await assert.rejects(
    releases.check(),
    (error) => error.status === 404 && /Noch kein.*Release/.test(error.message),
  );
});
for (const [current, candidate, upToDate] of [
  ["1.5.1", "1.5.1", true],
  ["1.5.1", "1.4.9", true],
  ["1.9.0", "1.10.0", false],
  ["2.0.0", "1.99.0", true],
  ["1.5.1", "1.5.1-rc.1", true],
  ["1.5.1-rc.2", "1.5.1-rc.10", false],
  ["1.5.1-rc.1", "1.5.1", false],
  ["1.5.1-beta", "1.5.1-alpha", true],
]) {
  test(`release check compares ${current} with ${candidate} semantically`, async (t) => {
    const releases = await fixture(t, current, candidate, { channel: official });
    assert.equal((await releases.check()).upToDate, upToDate);
    if (upToDate) await assert.rejects(releases.stage({ version: candidate }), /newer/i);
  });
}

test("official staging downloads the reviewed version from its immutable GitHub tag", async (t) => {
  const releases = await fixture(t, undefined, undefined, { channel: official });
  const manifestFetch = releases.fetchImpl;
  const requested = [];
  releases.fetchImpl = async (url) => {
    requested.push(url);
    return url.endsWith("latest.json")
      ? manifestFetch(url)
      : new Response("tampered archive");
  };
  await releases.check();
  await assert.rejects(releases.stage({ version: "1.6.0" }), /checksum/);
  assert.equal(
    requested.at(-1),
    "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/download/v1.6.0/release.aprelease",
  );
  assert.equal(releases.status().staged.length, 0);
  assert.equal(
    await fs.readFile(path.join(releases.installRoot, "current/release.json"), "utf8"),
    JSON.stringify({ version: "1.5.1" }),
  );
});
