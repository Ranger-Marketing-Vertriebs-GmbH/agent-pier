import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { eventually, hermesFakeRuntime } from "../helpers/hermes-fake-runtime.js";
import { cronRest, cronStore } from "../helpers/hermes-fake-cron.js";
import { contractAgent } from "../helpers/hermes-native.js";
import {
  fakeHermesSupervisor,
  hermesTestRuntime,
} from "../helpers/hermes-fake-gateway.js";
import { createHermesRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-runtime.js";
import { hermesAdvancedRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-config/advanced.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { hermesSchedule } from "../../server/features/assistants/runtimes/hermes/hermes-routine-jobs.js";
import { processZone } from "../../server/features/assistants/runtimes/hermes/hermes-cron-zone.js";

// The owner's advanced settings through a Hermes agent's own process set
// (hermes-runtime.js, hermes-config/advanced.js): the zone each start hands its
// processes and its routines, which changes restart it, and how existing chats take a
// new thinking level (hermes-sessions.js).

function agentSet(t, values) {
  const fake = hermesFakeRuntime(t);
  const state = { values };
  const made = createHermesRuntime({
    dataDir: fake.dataDir,
    agentId: "agent-1",
    runtime: async () => ({ ...fake.runtime, version: hermesAdvancedRuntime }),
    stopTimeoutMs: 3000,
    advanced: () => state.values,
  });
  t.after(() => made.supervisor.stop());
  const home = made.supervisor.agentPaths().hermesHome;
  const config = () =>
    readHermesConfig(fs.readFileSync(path.join(home, "config.yaml"), "utf8"));
  const lastEnv = () => fake.starts("agent-1").at(-1).env;
  return { fake, made, state, home, config, lastEnv };
}

// The gateway's cron routes in memory on the current connection (the fake processes
// answer no REST), kept across restarts like Hermes's jobs file.
function serveCron(client, cron) {
  const call = client.call.bind(client);
  client.call = async (method, params, options) =>
    method === "agentpier.http"
      ? cronRest(cron, new Map(), params)
      : call(method, params, options);
}

const berlin = { kind: "cron", expression: "0 9 * * *", timezone: "Europe/Berlin" };
const routine = {
  name: "Berlin",
  agentId: "agent-1",
  enabled: true,
  schedule: berlin,
  prompt: { text: "Morning" },
};

test("each start hands its processes and its routines the owner's time zone", async (t) => {
  const { made, state, home, config, lastEnv } = agentSet(t, {
    userTimezone: "Asia/Tokyo",
  });
  const cron = cronStore();
  // A key a start must not leave: the gateway would copy it over the variable.
  fs.writeFileSync(path.join(home, "config.yaml"), "timezone: UTC\n");
  await made.runtime.host.start();
  // The zone travels in the environment; config.yaml never holds it.
  assert.equal(lastEnv().HERMES_TIMEZONE, "Asia/Tokyo");
  assert.equal(config().timezone, undefined);
  serveCron(made.supervisor.client, cron);
  // A Berlin routine is pinned in the agent's zone, Tokyo.
  const added = await made.runtime.routines.add({ routine });
  const [job] = cron.jobs.values();
  assert.equal(job.schedule.expr, hermesSchedule(berlin, { zone: "Asia/Tokyo" }));
  // Reset: the next start runs in the host's zone, and the routine follows it.
  state.values = {};
  await made.runtime.host.restart();
  assert.equal(lastEnv().HERMES_TIMEZONE, undefined);
  serveCron(made.supervisor.client, cron);
  await made.runtime.routines.update({ id: added.id, patch: { enabled: true } });
  assert.equal(job.schedule.expr, hermesSchedule(berlin, { zone: processZone() }));
  // Values the store could not answer keep the zone of the last start.
  state.values = { userTimezone: "America/New_York" };
  await made.runtime.host.restart();
  state.values = undefined;
  await made.runtime.host.restart();
  assert.equal(lastEnv().HERMES_TIMEZONE, "America/New_York");
});

test("a thinking level change applies without a restart, a time zone change restarts", async (t) => {
  const { fake, made, state, config } = agentSet(t, { thinkingDefault: "high" });
  const desired = contractAgent("agent-1", { baseUrl: "http://127.0.0.1:9/v1" });
  await made.runtime.config.apply({ desired });
  assert.equal(fake.starts("agent-1").length, 1);
  assert.equal(config().agent.reasoning_effort, "high");
  // The gateway reads the level again at each turn.
  state.values = { thinkingDefault: "off" };
  assert.deepEqual(await made.runtime.config.apply({ desired }), {
    written: ["config.yaml"],
    restarted: false,
  });
  assert.equal(config().agent.reasoning_effort, "none");
  assert.equal(fake.starts("agent-1").length, 1);
  // The zone reaches the processes only at their start.
  state.values = { thinkingDefault: "off", userTimezone: "Asia/Tokyo" };
  const zoned = await made.runtime.config.apply({ desired });
  assert.equal(zoned.restarted, true);
  await eventually(() => fake.starts("agent-1").length === 2, 10000, "the restart");
  assert.equal(fake.starts("agent-1")[1].env.HERMES_TIMEZONE, "Asia/Tokyo");
  // Unchanged values: nothing restarts.
  assert.equal((await made.runtime.config.apply({ desired })).restarted, false);
});

test("an existing chat takes a new thinking level at its next turn", async () => {
  const supervisor = fakeHermesSupervisor({ agentId: "ap-1" });
  const runtime = hermesTestRuntime(supervisor);
  await supervisor.start();
  const { sessions } = runtime;
  const { store } = supervisor;
  const { key } = await sessions.create({ agentId: "ap-1", label: "Chat" });
  const turn = async (message) => {
    const { runId } = await sessions.send({ key, turn: { message } });
    await sessions.wait({ runId, waitMs: 5000 });
  };
  await turn("one");
  // The session runs at the level it froze at its create: nothing to change.
  assert.deepEqual(store.mutations, []);
  // The owner's level changes in the home; the chat follows before its next turn,
  // once.
  store.reasoning = "none";
  await turn("two");
  await turn("three");
  assert.equal(store.mutations.length, 1);
  assert.equal([...store.rows.values()][0].reasoning, "none");
  await runtime.host.stop();
});
