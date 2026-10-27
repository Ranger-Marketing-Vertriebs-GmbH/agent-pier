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
