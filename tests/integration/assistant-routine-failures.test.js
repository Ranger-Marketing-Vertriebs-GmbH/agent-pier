import test from "node:test";
import assert from "node:assert/strict";
import { routineFixture } from "../helpers/native-routines-fixture.js";
import { withRoutineResults } from "../../server/features/assistants/routine-results.js";

const restart = "cron: job interrupted by gateway restart";

test("a failed routine run names its cause in the list, its history and the chat", async (t) => {
  const f = routineFixture(t);
  const call = f.assistants.runtime.client.call;
  const runs = [];
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.runs") return { entries: runs };
    return call(method, input);
  };
  const routine = await f.routines.create(f.id, f.input);
  const jobId = f.reminders.bindings.get(routine.id).nativeId;
  const listed = async () =>
    (await f.routines.list(f.id)).routines.find((r) => r.id === routine.id);
  assert.equal((await listed()).lastFailure, null);

  // The Gateway restarted during the run (the owner's example).
  f.jobs.set(jobId, {
    ...f.jobs.get(jobId),
    state: {
      lastRunAtMs: 9000,
      lastRunStatus: "error",
      lastError: restart,
      consecutiveErrors: 1,
    },
  });
  assert.deepEqual((await listed()).lastFailure, {
    reason: "gateway-restart",
    message: restart,
    atMs: 9000,
    consecutive: 1,
  });

  // The run history: each failed run with its cause and OpenClaw's message.
  runs.push(
    { runAtMs: 9000, status: "error", error: restart, durationMs: 4000 },
    {
      runAtMs: 5000,
      status: "error",
      error: "401 Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz",
      errorReason: "auth",
    },
    { runAtMs: 1000, status: "ok", summary: "All hosts fine.", durationMs: 2000 },
  );
  const { entries } = await f.routines.runs(f.id, routine.id);
  assert.deepEqual(
    entries.map((e) => [e.runAtMs, e.failure?.reason ?? null]),
    [
      [9000, "gateway-restart"],
      [5000, "model"],
      [1000, null],
    ],
  );
  assert.equal(entries[1].failure.message, "401 Incorrect API key provided: •••");
  assert.equal(entries[2].summary, undefined, "a result is never part of the history");

  // The completion webhook's failure lands in the chat with its cause.
  await f.reminders.complete(routine.id, {
    jobId,
    runAtMs: 9000,
    status: "error",
    error: restart,
  });
  const results = f.routines.results.forConversation(f.channel.conversationId);
  const [note] = withRoutineResults([], results);
  assert.equal(note.event, "routine-failed");
  assert.deepEqual(note.failure, { reason: "gateway-restart", message: restart });
});
