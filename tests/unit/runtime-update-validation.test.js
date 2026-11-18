import test from "node:test";
import assert from "node:assert/strict";
import { AssistantMaintenance } from "../../server/features/assistants/assistant-maintenance.js";

// OpenClaw 2026.11.3 refuses an agent whose startup publication a concurrent refresh
// superseded until the Gateway restarts (runtime-bundle-patches.js).
const superseded = {
  agentId: "ap-a",
  code: "agent-database-inspection-failed",
  reason: "prepared model runtime publication was superseded for /state/agents/ap-a",
};
const pending = { agentId: "ap-a", code: "agent-database-inspection-pending" };
const unavailable = (refusal) =>
  Object.assign(Error("Assistant Gateway unavailable (UNAVAILABLE)."), {
    code: "UNAVAILABLE",
    answered: true,
    ...(refusal && {
      admissionRefusal: { agentId: refusal.agentId, code: refusal.code },
    }),
  });

// A Gateway supervisor whose n-th start (from 0) answers with `starts[n]`: `rosters`,
// the refusal of agent ap-a on each roster read (the last repeats), and `describe`,
// what reading a session does.
function fixture(starts) {
  const log = [];
  let generation = 0;
  const client = (n) => {
    const { rosters, describe = async () => ({ session: {} }) } = starts[n];
    let read = 0;
    return {
      ready: true,
      call: async (method, params) => {
        log.push(`${n}:${method}`);
        if (method === "agents.list") {
          const refusal = rosters[Math.min(read++, rosters.length - 1)];
          return {
            agents: [{ id: "ap-a", ...(refusal && { admissionRefusal: refusal }) }],
          };
        }
        if (method === "sessions.describe") return describe(params);
        throw new Error(`unexpected ${method}`);
      },
    };
  };
  const supervisor = {
    client: client(0),
    status: () => ({ availability: supervisor.client?.ready ? "ready" : "disabled" }),
    async stop() {
      log.push("stop");
      supervisor.client.ready = false;
    },
    async start() {
      log.push("start");
      supervisor.client = client(++generation);
    },
  };
  const maintenance = new AssistantMaintenance({
    assistantRuntime: supervisor,
    assistants: {
      ledger: { pending: () => [] },
      store: {
        listAssistants: () => [{ id: "a", runtimeAgentId: "ap-a", effectiveRevision: 1 }],
        listConversations: () => [{ id: "c1", runtimeSessionKey: "agent:ap-a:main" }],
      },
    },
    assistantChannels: { store: { list: () => [] } },
  });
  return { maintenance, log };
}

test("validation waits until the Gateway admitted its agents", async () => {
  const { maintenance, log } = fixture([{ rosters: [pending, pending, null] }]);
  await maintenance.validate();
  const described = log.indexOf("0:sessions.describe");
  assert.ok(described > 0);
  assert.equal(log.slice(0, described).filter((m) => m === "0:agents.list").length, 4);
  assert.ok(!log.includes("stop"));
});

test("an agent refused for a superseded publication restarts the Gateway once", async () => {
  const { maintenance, log } = fixture([
    {
      rosters: [superseded],
      describe: async () => Promise.reject(unavailable(superseded)),
    },
    { rosters: [null] },
  ]);
  await maintenance.validate();
  assert.deepEqual(
    log.filter((m) => ["stop", "start"].includes(m)),
    ["stop", "start"],
  );
  assert.ok(log.includes("1:sessions.describe"));
});

test("a refusal that outlives the restart fails, tagged with its check and code", async () => {
  const { maintenance, log } = fixture([
    { rosters: [superseded] },
    { rosters: [superseded] },
  ]);
  await assert.rejects(maintenance.validate(), {
    check: "roster:ap-a",
    errorCode: "agent-database-inspection-failed",
  });
  assert.equal(log.filter((m) => m === "start").length, 1);
});

test("another failure fails at once, tagged with the session it read", async () => {
  const { maintenance, log } = fixture([
    { rosters: [null], describe: async () => Promise.reject(unavailable()) },
  ]);
  await assert.rejects(maintenance.validate(), {
    check: "session:c1",
    errorCode: "UNAVAILABLE",
  });
  assert.ok(!log.includes("stop"));
});

test("a stopped Gateway fails the host check", async () => {
  const { maintenance } = fixture([{ rosters: [null] }]);
  maintenance.s.assistantRuntime.client.ready = false;
  await assert.rejects(maintenance.validate(), { check: "host", status: 503 });
});
