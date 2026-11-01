import test from "node:test";
import assert from "node:assert/strict";
import { hermesUpdateMaintenance } from "../../server/application/hermes-wiring.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { makeHermesRuntime } from "../helpers/hermes-fake-gateway.js";

// What blocks a Hermes update and what "Pause agents and update" does with it
// (hermes-wiring.js hermesUpdateMaintenance): only Hermes agents' work counts, a
// running turn is stopped through its Hermes session, a routine run under way is
// waited for, and anything unconfirmed is left alone.
async function fixture() {
  const hermesRuntime = await makeHermesRuntime("ap-h")();
  // The ports are frozen: a test replaces one through `swap`.
  const swapped = {};
  const current = () => ({ ...hermesRuntime, ...swapped });
  const supervisor = {};
  attachHermesFleet(supervisor, {
    runtimeOf: current,
    list: () => [{ runtime: current() }],
  });
  const { key } = await hermesRuntime.sessions.create({ agentId: "ap-h", label: "Main" });
  const agents = [
    { id: "a-h", name: "Hermes one", runtime: "hermes", runtimeAgentId: "ap-h" },
    { id: "a-o", name: "OpenClaw one", runtimeAgentId: "ap-o" },
  ];
  const chats = [
    { id: "c-h", assistantId: "a-h", runtimeSessionKey: key },
    { id: "c-o", assistantId: "a-o", runtimeSessionKey: "agent:ap-o:main" },
  ];
  const attempts = [
    { id: "t-h", requestId: "r-h", state: "running", runtimeRunId: "run-h" },
    { id: "t-o", requestId: "r-o", state: "running", runtimeRunId: "run-o" },
  ];
  const transitions = [];
  const assistants = {
    runtime: supervisor,
    store: {
      listAssistants: () => agents,
      getAssistant: (id) => agents.find((a) => a.id === id),
      getConversation: (id) => chats.find((c) => c.id === id),
    },
    ledger: {
      pending: () => attempts.filter((a) => a.state === "running"),
      getRequest: (id) => ({ conversationId: id === "r-h" ? "c-h" : "c-o" }),
      getAttempt: (id) => attempts.find((a) => a.id === id),
      transition(id, state) {
        transitions.push([id, state]);
        attempts.find((a) => a.id === id).state = state;
      },
    },
    changed() {},
  };
  const services = { assistants, audit: { append() {} } };
  return {
    services,
    hermesRuntime,
    transitions,
    key,
    swap: (ports) => Object.assign(swapped, ports),
  };
}

test("only Hermes agents' turns and routine runs block a Hermes update", async () => {
  const { services, hermesRuntime, swap } = await fixture();
  const maintenance = hermesUpdateMaintenance(services);
  const items = await maintenance.blockerItems();
  assert.deepEqual(
    items.map((i) => [i.code, i.kind, i.ref.id, i.resolution, i.agent.name]),
    [["ASSISTANT_WORK", "chat_turn", "t-h", "stop", "Hermes one"]],
  );
  assert.deepEqual(await maintenance.blockers(), ["ASSISTANT_WORK"]);
  // A routine run under way counts too, waited for.
  const job = await hermesRuntime.routines.add({
    routine: {
      name: "Inbox",
      marker: "agentpier-reminder:x",
      agentId: "ap-h",
      enabled: true,
      schedule: { kind: "every", everyMs: 3600000 },
      target: { kind: "own" },
      prompt: { text: "Hi" },
      delivery: { kind: "none" },
    },
  });
  const { routines } = hermesRuntime;
  swap({
    routines: {
      ...routines,
      list: async (input) =>
        (await routines.list(input)).map((r) => ({ ...r, runState: { runningAtMs: 1 } })),
    },
  });
  const withRun = await maintenance.blockerItems();
  assert.deepEqual(
    withRun.map((i) => [i.code, i.kind, i.ref.id, i.resolution]),
    [
      ["ASSISTANT_WORK", "chat_turn", "t-h", "stop"],
      ["SCHEDULED_WORK", "routine_run", job.id, "wait"],
    ],
  );
});

test("Pause agents and update stops a Hermes turn through its own session", async () => {
  const { services, hermesRuntime, transitions, key, swap } = await fixture();
  const aborted = [];
  swap({
    sessions: {
      ...hermesRuntime.sessions,
      abort: async (input) => {
        aborted.push(input);
        return { aborted: true };
      },
    },
  });
  const maintenance = hermesUpdateMaintenance(services);
  const items = await maintenance.blockerItems();
  // Nothing is touched for an item the owner did not confirm as it is.
  assert.equal(
    (await maintenance.resolve([{ id: items[0].id, revision: "old" }])).length,
    1,
  );
  assert.deepEqual(aborted, []);
  const remaining = await maintenance.resolve(
    items.map(({ id, revision }) => ({ id, revision })),
    { waitMs: 0 },
  );
  assert.deepEqual(remaining, []);
  assert.deepEqual(aborted, [{ key, runId: "run-h" }]);
  assert.deepEqual(transitions, [["t-h", "cancelled"]]);
});
