import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  contractShards,
  splitShards,
  weightOf,
} from "../../scripts/assistant-contract-shards.mjs";
import { runtimeVariables } from "../../scripts/provision-assistant-contracts.mjs";

const root = new URL("../../", import.meta.url);

test("every listed native contract exists and every weight belongs to one", () => {
  for (const file of contractShards.files)
    assert.ok(fs.existsSync(new URL(file, root)), file);
  for (const file of Object.keys(contractShards.seconds))
    assert.ok(contractShards.files.includes(file), `stale weight ${file}`);
});

// The variables the native-contracts job sets to the provisioned runtime
// (scripts/provision-assistant-contracts.mjs). A test that reads one skips in
// `npm test` and runs only where it is listed, so an unlisted one runs nowhere: the
// image contract and the patch paths contract broke unnoticed that way when OpenClaw
// 2026.11.6 was pinned.
const outsideTheJob = {
  // Needs the runtime of an earlier release too: the nightly cross-version job.
  crossVersion: (source) => source.includes("AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME"),
  // Needs real provider credentials: run by hand.
  liveProvider: (source) => source.includes("AGENTPIER_ASSISTANT_LIVE"),
};

test("every contract gated on a runtime variable runs in the native-contracts job", () => {
  const dir = new URL("tests/integration/", root);
  const workflow = fs.readFileSync(
    new URL(".github/workflows/assistant-runtime.yml", root),
    "utf8",
  );
  const gated = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".test.js"))) {
    const source = fs.readFileSync(new URL(name, dir), "utf8");
    if (!runtimeVariables.some((variable) => source.includes(variable))) continue;
    gated.push(name);
    if (outsideTheJob.liveProvider(source)) continue;
    if (outsideTheJob.crossVersion(source)) {
      assert.ok(workflow.includes(`tests/integration/${name}`), `cross-version: ${name}`);
      continue;
    }
    assert.ok(contractShards.files.includes(`tests/integration/${name}`), name);
  }
  // The scan finds them: a renamed variable must not empty the check.
  for (const name of [
    "assistant-provider-contract.test.js",
    "assistant-image-contract.test.js",
    "assistant-patch-paths-contract.test.js",
    "assistant-runtime-cross-version.test.js",
  ])
    assert.ok(gated.includes(name), name);
});

test("shards partition the contracts deterministically for every total", () => {
  for (let total = 1; total <= 8; total++) {
    const shards = splitShards(total);
    assert.equal(shards.length, total);
    const all = shards.flatMap((shard) => shard.files);
    assert.deepEqual([...all].sort(), [...contractShards.files].sort());
    assert.equal(new Set(all).size, all.length);
    assert.ok(shards.every((shard) => shard.files.length > 0));
    assert.deepEqual(splitShards(total), shards);
  }
});

test("the CI shard counts stay balanced by the recorded weights", () => {
  for (const total of [4, 6]) {
    const seconds = splitShards(total).map((shard) => shard.seconds);
    assert.ok(Math.max(...seconds) - Math.min(...seconds) < 60, `${total}: ${seconds}`);
  }
});

test("a contract without a measurement weighs the median", () => {
  const seconds = { "a.test.js": 10, "b.test.js": 30, "c.test.js": 50 };
  assert.equal(weightOf("new.test.js", seconds), 30);
  const shards = splitShards(2, {
    files: ["a.test.js", "b.test.js", "c.test.js", "new.test.js"],
    seconds,
  });
  assert.deepEqual(
    shards.map((shard) => shard.files),
    [
      ["a.test.js", "c.test.js"],
      ["b.test.js", "new.test.js"],
    ],
  );
  assert.throws(() => splitShards(0), /Invalid total/);
});

test("every contract gated on the Hermes runtime runs in the hermes-contracts job", () => {
  // The job runs tests/integration/*hermes*-contract.test.js; anything else skips.
  const dir = new URL("tests/integration/", root);
  for (const name of fs.readdirSync(dir)) {
    const source = fs.readFileSync(new URL(name, dir), "utf8");
    if (!source.includes("process.env.AGENTPIER_HERMES_CONTRACT_RUNTIME")) continue;
    assert.match(name, /hermes.*-contract\.test\.js$/, name);
  }
  const workflow = fs.readFileSync(
    new URL(".github/workflows/assistant-runtime.yml", root),
    "utf8",
  );
  assert.match(workflow, /-name '\*hermes\*-contract\.test\.js'/);
});
