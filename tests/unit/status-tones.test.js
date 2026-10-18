import test from "node:test";
import assert from "node:assert/strict";
import { activityTone, chipTone } from "../../web/components/status-tones.js";

test("activity and chip states map onto the StatusDot tones", () => {
  assert.equal(activityTone("working"), "working");
  assert.equal(activityTone("waiting"), "waiting");
  assert.equal(activityTone("unknown"), "unknown");
  assert.equal(activityTone("stopped"), "pending");
  assert.equal(activityTone("terminal"), "idle");
  assert.equal(activityTone(undefined), "idle");
  assert.equal(chipTone("running"), "working");
  assert.equal(chipTone("neutral"), "idle");
  for (const tone of ["ok", "error", "pending", "waiting"])
    assert.equal(chipTone(tone), tone);
});
