import test from "node:test";
import assert from "node:assert/strict";
import { SessionActivity } from "../../server/features/sessions/session-activity.js";

const codex = (status = "") =>
  `${status}\n\n› \x1b[2mAsk Codex to do anything\x1b[0m\n\n  gpt-6-astra high · ~/project`;

test("activity reports since when a session is in its current state", async () => {
  let now = Date.parse("2026-10-27T18:00:00Z");
  let pending = false;
  const activity = new SessionActivity({
    sessions: {},
    screen: async () => codex(),
    pending: () => pending,
    cacheMs: 0,
    now: () => now,
  });
  const session = { id: "since", tool: "codex", status: "running" };
  const first = await activity.read(session);
  assert.equal(first.state, "idle");
  assert.equal(first.since, "2026-10-27T18:00:00.000Z");
  now += 60_000;
  assert.equal(
    (await activity.read(session)).since,
    first.since,
    "same state, same start",
  );
  pending = true;
  now += 60_000;
  const waiting = await activity.read(session);
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.since, "2026-10-27T18:02:00.000Z");
  // A stopped session has no running state to date; a new run starts afresh.
  assert.equal((await activity.read({ ...session, status: "stopped" })).since, undefined);
  pending = false;
  now += 60_000;
  assert.equal((await activity.read(session)).since, "2026-10-27T18:03:00.000Z");
});

test("a passing unknown reading keeps the span of the state around it", () => {
  const activity = new SessionActivity({ sessions: {} });
  const at = (minute) => Date.parse("2026-10-27T18:00:00Z") + minute * 60_000;
  const iso = (minute) => new Date(at(minute)).toISOString();
  assert.equal(activity.since("s", "working", at(0)), iso(0));
  assert.equal(activity.since("s", "unknown", at(1)), iso(0), "unknown keeps it");
  assert.equal(activity.since("s", "working", at(2)), iso(0), "back to the same state");
  assert.equal(activity.since("s", "unknown", at(3)), iso(0));
  assert.equal(
    activity.since("s", "idle", at(4)),
    iso(4),
    "a new known state starts anew",
  );
  // A session first read as unknown keeps that start for its first known state.
  assert.equal(activity.since("t", "unknown", at(5)), iso(5));
  assert.equal(activity.since("t", "idle", at(6)), iso(5));
  assert.equal(activity.since("t", "working", at(7)), iso(7));
});
