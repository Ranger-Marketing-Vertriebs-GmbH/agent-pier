import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  contractShards,
  splitShards,
  weightOf,
} from "../../scripts/assistant-contract-shards.mjs";

const root = new URL("../../", import.meta.url);

test("every listed native contract exists and every weight belongs to one", () => {
  for (const file of contractShards.files)
    assert.ok(fs.existsSync(new URL(file, root)), file);
  for (const file of Object.keys(contractShards.seconds))
    assert.ok(contractShards.files.includes(file), `stale weight ${file}`);
});

test("every contract gated on the installed runtime runs in the native-contracts job", () => {
  // Such a contract skips in `npm test`; only the listed files run where it is set.
  const dir = new URL("tests/integration/", root);
  for (const name of fs.readdirSync(dir)) {
    const source = fs.readFileSync(new URL(name, dir), "utf8");
    // A live contract needs real provider credentials and runs only by hand.
    if (
      !source.includes("AGENTPIER_ASSISTANT_PROVIDER_RUNTIME") ||
      source.includes("AGENTPIER_ASSISTANT_LIVE")
    )
      continue;
    assert.ok(contractShards.files.includes(`tests/integration/${name}`), name);
  }
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
