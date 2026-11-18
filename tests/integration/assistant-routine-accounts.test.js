import test from "node:test";
import assert from "node:assert/strict";
import { routineFixture } from "../helpers/native-routines-fixture.js";

// OpenClaw 2026.11.3 runs an agent-turn job on a stored account (an AgentPier-held
// ChatGPT login) only with that account recorded on the job. Jobs from before the
// update carry none; the Gateway's start and an agent's model change adopt it
// (openclaw-routine-accounts.js), every agent's jobs, AgentPier's routines or not.
const profileId = "openai:owner@example.invalid";

function withAgentModel(f, model) {
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "config.get") {
      const runtimeAgentId = f.store.getAssistant(f.id).runtimeAgentId;
      return { config: { agents: { entries: { [runtimeAgentId]: { model } } } } };
    }
    return call(method, input);
  };
}
const updates = (f) =>
  f.calls.filter((c) => c.method === "cron.update").map((c) => c.input.patch.payload);

test("the Gateway's start records the agent's ChatGPT account on its routines", async (t) => {
  const f = routineFixture(t);
  withAgentModel(f, `openai/gpt-6-astra@${profileId}`);
  await f.routines.create(f.id, f.input);
  const agent = f.store.getAssistant(f.id);
  // A job the agent scheduled itself, outside AgentPier's routines.
  f.jobs.set("own-job", {
    id: "own-job",
    agentId: agent.runtimeAgentId,
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Check the news." },
    state: {},
  });
  f.calls.length = 0;
  await f.routines.reconcile();
  const adopted = f.calls
    .filter((c) => c.method === "cron.update" && c.input.patch.payload?.model)
    .map((c) => c.input.id);
  assert.deepEqual(adopted.sort(), ["job-0", "own-job"]);
  // Each adopts the account, then follows the agent's model again.
  assert.deepEqual(
    updates(f).filter((p) => p.model !== undefined),
    [
      { kind: "agentTurn", model: `openai/gpt-6-astra@${profileId}` },
      { kind: "agentTurn", model: null },
      { kind: "agentTurn", model: `openai/gpt-6-astra@${profileId}` },
      { kind: "agentTurn", model: null },
    ],
  );
});

test("an agent on a configured key records nothing; a refused account is reported", async (t) => {
  const f = routineFixture(t);
  withAgentModel(f, { primary: "fixture/fixture-model" });
  await f.routines.create(f.id, f.input);
  f.calls.length = 0;
  await f.routines.adoptAccounts(f.store.getAssistant(f.id));
  assert.deepEqual(updates(f), []);

  withAgentModel(f, `openai/gpt-6-astra@${profileId}`);
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.update" && input.patch.payload?.model)
      throw new Error("The selected automation account is unavailable.");
    return call(method, input);
  };
  const warnings = [];
  const warn = console.warn;
  console.warn = (line) => warnings.push(line);
  t.after(() => (console.warn = warn));
  await f.routines.adoptAccounts(f.store.getAssistant(f.id));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /job-0 .* has no usable model account: The selected/);
});
