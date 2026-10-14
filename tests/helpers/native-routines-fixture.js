import assert from "node:assert/strict";
import { channelFixture } from "./assistant-channel-fixture.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";

// A paired agent with reminders on, a routine adapter and an in-memory cron store
// standing in for the Gateway (cron.list/add/update/remove/run).
export function routineFixture(t) {
  const f = channelFixture(t),
    id = f.channel.assistantId,
    jobs = new Map(),
    calls = [];
  f.store.updateAssistant(id, { capabilities: { memory: false, reminders: true } }, 1);
  f.assistants.admit = (fn) => Promise.resolve().then(fn);
  f.assistants.requireReady = () => {};
  f.assistants.config = { apply: async () => {} };
  f.assistants.runtime.client.call = async (method, input) => {
    calls.push({ method, input });
    if (method === "cron.list") return { jobs: [...jobs.values()], hasMore: false };
    if (method === "cron.add") {
      const job = { ...input, id: `job-${jobs.size}`, updatedAtMs: 1, state: {} };
      jobs.set(job.id, job);
      return { job };
    }
    if (method === "cron.update") {
      const job = {
        ...jobs.get(input.id),
        ...input.patch,
        updatedAtMs: jobs.get(input.id).updatedAtMs + 1,
      };
      jobs.set(job.id, job);
      return job;
    }
    if (method === "cron.remove") {
      jobs.delete(input.id);
      return { removed: true };
    }
    if (method === "cron.run") return { ok: true, enqueued: true, runId: "native-run" };
    assert.fail(method);
  };
  const reminders = new NativeReminders({
    assistants: f.assistants,
    channels: f.service,
    dataDir: f.dataDir,
  });
  f.assistants.reminders = reminders;
  const routines = new NativeRoutines({ reminders });
  t.after(() => reminders.close());
  const input = {
    clientRequestId: "routine-1",
    name: "Meal plan",
    prompt: "Create a vegetarian meal plan for today.",
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
  };
  return { ...f, id, jobs, calls, reminders, routines, input };
}
