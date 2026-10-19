import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lead } from "./lead-request-service-fixture.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";

/**
 * The lead fixture (a finished team whose second member is permanent) with routines
 * on a fake Gateway cron store: the permanent member has routines on, every audit
 * record is kept, and `turn(text)` is an owner turn of the lead. `tool(action, input,
 * inv)` calls agentpier_team_member_routine; `run(binding, event)` completes a run.
 */
export async function leadRoutineFixture(t) {
  const f = await lead(t);
  const jobs = new Map(),
    audits = [];
  f.assistants.audit = { append: (event) => audits.push(event) };
  const member = f.store.getAssistant(f.permanent.assistantId);
  f.store.updateAssistant(
    member.id,
    { capabilities: { ...member.capabilities, memory: true, reminders: true } },
    member.revision,
  );
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
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
    return call(method, input);
  };
  f.assistants.requireReady = () => {};
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-routines-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const channels = {
    store: { list: () => [], get: () => null },
    outbox: { all: () => [], enqueue() {} },
  };
  const reminders = new NativeReminders({
    assistants: f.assistants,
    channels,
    dataDir,
    notifications: { notify: async () => {} },
  });
  f.assistants.reminders = reminders;
  const routines = new NativeRoutines({ reminders });
  f.assistants.routines = routines;
  t.after(() => reminders.close());
  const tool = (
    action,
    input = {},
    inv = f.turn("Please set up a routine on Member 1"),
  ) => f.service.member_routine(inv, { action, ...input });
  const create = (extra = {}, inv) =>
    tool(
      "create",
      {
        memberId: f.permanent.id,
        name: "Inbox check",
        prompt: "Check the shared inbox and report new requests.",
        trigger: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
        ...extra,
      },
      inv,
    );
  const run = (bindingId, event) => {
    const binding = routines.bindings.get(bindingId);
    return reminders.complete(bindingId, {
      jobId: binding.nativeId,
      runAtMs: Date.now(),
      status: "ok",
      summary: "Two new requests arrived.",
      deliveryStatus: "delivered",
      ...event,
    });
  };
  return { ...f, jobs, audits, member, reminders, routines, tool, create, run };
}
