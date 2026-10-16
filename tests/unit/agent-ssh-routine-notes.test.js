import test from "node:test";
import assert from "node:assert/strict";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { withRoutineResults } from "../../server/features/assistants/routine-results.js";

test("a refusal in a routine run reaches its completion record once", () => {
  const routines = Object.create(NativeRoutines.prototype);
  routines.refusals = new Map();
  const recorded = [];
  routines.results = { record: (entry) => recorded.push(entry) };
  routines.conversation = () => ({ id: "chat" });
  routines.noteRefusal("agent:ap-x:cron:JOB-1:run:abc", "ssh_refused");
  routines.noteRefusal("agent:ap-x:main", "ssh_refused");
  const binding = { id: "b", definition: { name: "Nightly" } };
  routines.completed(binding, {
    jobId: "job-1",
    runAtMs: 5,
    status: "ok",
    summary: "Done",
    deliveryStatus: "delivered",
  });
  routines.completed(binding, {
    jobId: "job-1",
    runAtMs: 6,
    status: "ok",
    summary: "Again",
  });
  assert.deepEqual(recorded[0].notes, ["ssh_refused"]);
  assert.equal(recorded[1].notes, undefined);
});

test("a refusal left by an earlier run never reaches a later run's record", () => {
  const routines = Object.create(NativeRoutines.prototype);
  routines.refusals = new Map();
  const recorded = [];
  routines.results = { record: (entry) => recorded.push(entry) };
  routines.conversation = () => ({ id: "chat" });
  // The earlier run completed silently, without a record that took its note.
  routines.noteRefusal("agent:ap-x:cron:job-1:run:old", "ssh_refused");
  const binding = { id: "b", definition: { name: "Nightly" } };
  routines.completed(binding, {
    jobId: "job-1",
    runAtMs: Date.now() + 60_000,
    status: "ok",
    summary: "Later",
  });
  assert.equal(recorded[0].notes, undefined);
  assert.equal(routines.refusals.size, 0);
  // A stale note does not hide the same refusal in the next run.
  routines.noteRefusal("agent:ap-x:cron:job-1:run:old", "ssh_refused");
  const runAtMs = Date.now();
  routines.noteRefusal("agent:ap-x:cron:job-1:run:new", "ssh_refused");
  routines.completed(binding, { jobId: "job-1", runAtMs, status: "error" });
  assert.deepEqual(recorded[1].notes, ["ssh_refused"]);
});

test("routine results carry their notes into the chat", () => {
  const messages = withRoutineResults(
    [{ id: "m", role: "assistant", text: "Done", timestamp: 10 }],
    [
      {
        id: "j:5",
        status: "ok",
        committed: true,
        text: "Done",
        name: "Nightly",
        runAtMs: 5,
        at: 11,
        notes: ["ssh_refused"],
      },
      {
        id: "j:6",
        status: "error",
        name: "Nightly",
        runAtMs: 20,
        at: 21,
        notes: ["ssh_refused"],
      },
    ],
  );
  assert.deepEqual(messages[0].scheduled, { name: "Nightly", notes: ["ssh_refused"] });
  assert.deepEqual(messages[1].notes, ["ssh_refused"]);
});
