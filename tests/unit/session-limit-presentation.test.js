import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { sessionActivity } from "../../web/features/sessions/sessionPresentation.js";
import { liveActivity } from "../../web/features/chat/live-status.js";
import { SessionActivity } from "../../server/features/sessions/session-activity.js";

setLanguage("en", { persist: false, document: {} });

const running = (activity) => ({ status: "running", tool: "claude", activity });

test("a session idle at a usage limit shows Limit reached, not Ready", () => {
  assert.deepEqual(sessionActivity(running({ state: "idle", limit: { detail: "x" } })), {
    state: "idle",
    label: "Limit reached",
    limited: true,
  });
  assert.deepEqual(sessionActivity(running({ state: "idle" })), {
    state: "idle",
    label: "Ready",
  });
  assert.equal(
    sessionActivity(running({ state: "working", limit: { detail: "x" } })).limited,
    undefined,
  );
});

test("the live status keeps the limited look while idle and drops it once working", () => {
  const activity = {
    state: "idle",
    label: "Limit reached",
    limited: true,
    observedAt: "2026-11-17T10:00:00.000Z",
  };
  const at = Date.parse(activity.observedAt) + 1000;
  const idle = liveActivity(activity, { state: "idle", at });
  assert.equal(idle.limited, true);
  assert.equal(idle.label, "Limit reached");
  const working = liveActivity(activity, { state: "working", at });
  assert.equal(working.limited, undefined);
  assert.equal(working.label, "Working");
});

test("the server labels a limited idle activity", async () => {
  const activity = new SessionActivity({
    sessions: {},
    screen: async () => "",
    hooks: () => ({ state: "idle", at: Date.now(), limit: { detail: "x" } }),
  });
  const read = await activity.read({
    id: "s1",
    tool: "claude",
    status: "running",
    cwd: "/x",
  });
  assert.equal(read.state, "idle");
  assert.equal(read.label, "Limit erreicht");
  assert.deepEqual(read.limit, { detail: "x" });
});
