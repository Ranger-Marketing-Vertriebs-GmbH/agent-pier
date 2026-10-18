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

test("the agent header dot marks a failed runtime as an error and attention as a warning", async () => {
  const { headerDotTone } =
    await import("../../web/features/assistants/assistant-status.js");
  assert.equal(headerDotTone("attention", "failed"), "error");
  assert.equal(headerDotTone("attention", "stale"), "warning");
  assert.equal(headerDotTone("attention", "ready"), "warning");
  assert.equal(headerDotTone("ready", "ready"), "ok");
  assert.equal(headerDotTone("working", "ready"), "working");
  assert.equal(headerDotTone("muted", "starting"), "idle");
});
