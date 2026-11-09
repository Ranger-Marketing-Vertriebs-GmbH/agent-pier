import test from "node:test";
import assert from "node:assert/strict";
import { routineFixture } from "../helpers/native-routines-fixture.js";
import { runtimeFor } from "../../server/features/assistants/runtimes/runtime-for.js";

// A reminder's or routine's text becomes a prompt OpenClaw runs later; on an agent
// shared with users it names no local image OpenClaw would load by itself
// (runtimes/openclaw/shared-prompts.js), whoever scheduled it.
const path = "./media/inbound/openclaw-staged-1/input-a.png";
const sent = (f, method) =>
  f.calls.filter((c) => c.method === method).map((c) => c.input);

function share(f) {
  f.store.db.prepare("UPDATE assistants SET body=? WHERE id=?").run(
    JSON.stringify({
      ...f.store.storedAssistant(f.id),
      userAccess: {
        mode: "shared",
        members: [
          { userId: "anna", level: "chat" },
          { userId: "ben", level: "chat" },
        ],
        released: [],
      },
    }),
    f.id,
  );
  return f.store.getAssistant(f.id);
}

test("a shared agent's reminder and routine prompts load no image by path", async (t) => {
  const f = routineFixture(t);
  const agent = share(f);
  await f.reminders.create(f.id, {
    clientRequestId: "reminder-1",
    name: "Look",
    message: `Describe ${path}`,
    schedule: { kind: "at", at: "2099-01-01T09:00:00+01:00" },
  });
  const [job] = sent(f, "cron.add");
  assert.ok(job.payload.message.endsWith(`Describe ⁠${path}`), job.payload.message);
  // Every add and update through the agent's port, on any connection.
  const routines = runtimeFor(agent, f.assistants.runtime).routines;
  const prompt = { text: `Open ${path}`, timeoutSeconds: 60 };
  await routines.update({ id: "job-0", patch: { prompt } });
  const update = sent(f, "cron.update").at(-1);
  assert.equal(update.patch.payload.message, `Open ⁠${path}`);
});

test("the owner's own agent keeps its prompts as written", async (t) => {
  const f = routineFixture(t);
  await f.reminders.create(f.id, {
    clientRequestId: "reminder-1",
    name: "Look",
    message: `Describe ${path}`,
    schedule: { kind: "at", at: "2099-01-01T09:00:00+01:00" },
  });
  assert.ok(sent(f, "cron.add")[0].payload.message.endsWith(`Describe ${path}`));
});
