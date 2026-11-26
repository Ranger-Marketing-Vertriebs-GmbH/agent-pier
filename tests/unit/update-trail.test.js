import test from "node:test";
import assert from "node:assert/strict";
import { updateTrail, withinTrail } from "../helpers/update-trail.js";

test("a stalled native update names the phase and step it stalled in", async () => {
  const updates = { journal: { phase: "idle" }, onChange: null };
  const trail = updateTrail(updates);
  trail.mark("start");
  updates.journal.phase = "migrating";
  updates.onChange();
  updates.onChange();
  await assert.rejects(
    withinTrail(20, trail, () => new Promise(() => {})),
    /did not finish within 20 ms: start @\d+\.\ds -> phase:migrating @\d+\.\ds$/,
  );
});

test("a native update that finishes in time returns its result and keeps listeners", async () => {
  let heard = 0;
  const updates = { journal: { phase: "idle" }, onChange: () => heard++ };
  const trail = updateTrail(updates);
  updates.onChange();
  assert.equal(heard, 1);
  assert.equal(await withinTrail(1000, trail, async () => "done"), "done");
  await assert.rejects(
    withinTrail(1000, trail, async () => {
      throw Error("own failure");
    }),
    /own failure/,
  );
});
