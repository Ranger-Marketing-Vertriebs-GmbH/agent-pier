import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { rebuildsFixture, until } from "../helpers/craft-rebuilds-fixture.js";

/** The pids of the processes whose command line mentions `text`. */
const processesWith = (text) =>
  execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(text))
    .map((line) => Number(line.trim().split(/\s+/)[0]));

test("a malformed rebuild_start answer stops the build it started", async (t) => {
  const f = rebuildsFixture(t, { script: { emptyTools: ["rebuild_start"] } });
  await assert.rejects(f.rebuilds.start({ request: "Malformed" }), { status: 409 });
  assert.deepEqual(fs.readdirSync(f.projectsDir), []);
  assert.equal(f.rebuilds.list().length, 0);
  assert.ok(
    await until(() => processesWith(`fake-craft-builder ${f.projectsDir}`).length === 0),
    "no builder is left in the removed folder",
  );
});
