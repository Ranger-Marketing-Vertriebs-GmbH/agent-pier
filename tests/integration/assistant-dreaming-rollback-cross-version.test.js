import test from "node:test";
import assert from "node:assert/strict";
import { deleteNativeSession } from "../../server/features/assistants/chat-removal.js";
import { dreamingSection } from "../../server/features/assistants/openclaw-config/dreaming.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { contractTimeout } from "../helpers/contract-timeout.js";
import {
  dreamingKey,
  dreamingOn,
  nativeFixture,
  openClawVersion,
} from "../helpers/assistant-dreaming-fixture.js";

// AGENTPIER-234: an activation that fails validation rolls the runtime back to a
// qualified predecessor (runtimeManifest.rollbackTargets), which then runs with
// this release's compiled configuration, the owner's dreaming section included.
// This pins dreaming there: the section is accepted, the managed job follows the
// switch and a live hour change, a sweep keeps each agent to its own chats, and a
// deleted chat leaves dreaming. The cross-version job provisions each rollback
// target (AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME); elsewhere it skips.
const previous = process.env.AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME;

test(
  "rollback runtime: dreaming follows the compiled switch and keeps agents apart",
  { skip: !previous, timeout: contractTimeout(420000) },
  async (t) => {
    t.diagnostic(`openclaw=${openClawVersion(previous)}`);
    const f = await nativeFixture(t, { root: previous });
    const memory = { memory: true, reminders: false };
    const orchid = await f.create("Orchid", memory, "orchid-model");
    const fern = await f.create("Fern", memory, "fern-model");
    assert.deepEqual(await f.dreamingJobs(), [], "the compiled default schedules none");
    const chat = await f.turn(orchid, "I water the orchids every Sunday DREAMORCHID.");
    await f.turn(fern, "I water the ferns every Monday DREAMFERN.");

    await f.dreaming(dreamingOn);
    const job = await f.job();
    assert.equal(job.declarationKey, dreamingKey);
    assert.equal(job.schedule.expr, "0 3 * * *");
    assert.equal(job.schedule.tz, "Europe/Berlin");
    t.diagnostic(`dreaming job: ${JSON.stringify(job)}`);
    const run = await f.forceRun(job.id);
    assert.equal(run.status, "ok", JSON.stringify(run));
    await f.settle({ files: [f.diary(orchid), f.diary(fern)] });
    assert.match(f.corpus(orchid), /DREAMORCHID/);
    assert.doesNotMatch(f.corpus(orchid), /DREAMFERN/);
    assert.match(f.corpus(fern), /DREAMFERN/);
    assert.doesNotMatch(f.corpus(fern), /DREAMORCHID/);

    // The hour change as DreamingService applies it: a live patch, no restart.
    const { child, client, generation } = f.runtime;
    const next = { enabled: true, hour: 4, timeZone: "Europe/Berlin" };
    await patchConfig(client, () => ({
      patch: {
        plugins: {
          entries: { "memory-core": { config: { dreaming: dreamingSection(next) } } },
        },
      },
      replacePaths: ["plugins.entries.memory-core.config.dreaming"],
    }));
    const moved = await f.until(
      async () => {
        const jobs = await f.dreamingJobs();
        return jobs.length === 1 && jobs[0].schedule.expr === "0 4 * * *" && jobs[0];
      },
      30000,
      "the job at the new hour",
    );
    assert.equal(f.runtime.child, child, "the Gateway process was not replaced");
    assert.equal(f.runtime.generation, generation);

    // Deleted as AgentPier deletes a chat: the session, its archive, then dreaming.
    const assistants = {
      runtime: f.runtime,
      store: f.store,
      ledger: { forgetTexts() {} },
    };
    const conversation = f.store.saveConversation({
      assistantId: orchid.id,
      runtimeSessionKey: chat,
    });
    assert.equal(await deleteNativeSession(assistants, conversation), true);
    await assistants.dreamingForgets;
    assert.doesNotMatch(f.corpus(orchid), /DREAMORCHID/);
    assert.match(f.corpus(fern), /DREAMFERN/, "another agent's corpus stays");
    await f.turn(orchid, "Tomatoes need water daily DREAMTOMATO.");
    assert.equal((await f.forceRun(moved.id)).status, "ok");
    await f.settle();
    assert.match(f.corpus(orchid), /DREAMTOMATO/);
    assert.doesNotMatch(f.corpus(orchid), /DREAMORCHID/, "it stays out of later runs");

    // Switched off, the managed job goes.
    await f.dreaming({ enabled: false });
    await f.until(async () => (await f.dreamingJobs()).length === 0, 30000, "no job");
  },
);
