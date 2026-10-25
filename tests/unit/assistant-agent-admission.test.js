import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  admissionDone,
  agentDegraded,
  degradedAgents,
  noteRefusal,
  settledAdmission,
  withAdmission,
} from "../../server/features/assistants/agent-admission.js";
import {
  configWrite,
  patchConfig,
} from "../../server/features/assistants/openclaw-config/live-patch.js";
import { sendRefusal } from "../../server/features/assistants/conversation-turns.js";

const pending = (id) => ({
  id,
  status: "degraded",
  admissionRefusal: { code: "agent-database-inspection-pending" },
});
const failed = (id) => ({
  id,
  status: "degraded",
  admissionRefusal: { code: "agent-database-inspection-failed" },
});
const answered = (code, extra = {}) =>
  Object.assign(Error(code), { code, answered: true, ...extra });

// A Gateway whose agents.list answers the given rosters in turn (the last repeats).
function gateway(rosters) {
  const client = new EventEmitter();
  client.calls = [];
  client.call = async (method, params) => {
    client.calls.push(method);
    if (method !== "agents.list") return client.answer?.(method, params) ?? {};
    const next = rosters.length > 1 ? rosters.shift() : rosters[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return client;
}
const clock = () => {
  let at = 0;
  return { now: () => at, sleep: async (ms) => void (at += ms), warn: () => {} };
};

test("config writes wait until the Gateway admitted every agent", async () => {
  const client = gateway([
    { agents: [{ id: "main" }, pending("ap-a"), pending("ap-b")] },
    { agents: [{ id: "main" }, { id: "ap-a" }, pending("ap-b")] },
    { agents: [{ id: "main" }, { id: "ap-a" }, { id: "ap-b" }] },
  ]);
  const options = clock();
  await settledAdmission(client, options);
  assert.deepEqual(client.calls, ["agents.list", "agents.list", "agents.list"]);
  assert.equal(degradedAgents(client).size, 0);
  // Settled once per connection: later writes do not ask again.
  await settledAdmission(client, options);
  assert.equal(client.calls.length, 3);
  // A reconnect may reach a Gateway that started again in place.
  client.emit("disconnected");
  await settledAdmission(client, options);
  assert.equal(client.calls.length, 4);
});

test("writers that waited together run one after the other, never on one base hash", async () => {
  const client = gateway([{ agents: [pending("ap-a")] }, { agents: [{ id: "ap-a" }] }]);
  let hash = 0;
  client.answer = (method, params) => {
    if (method === "config.get") return { hash: `h${hash}`, config: {} };
    // As OpenClaw refuses a stale base hash.
    if (params.baseHash !== `h${hash}`) throw answered("INVALID_REQUEST");
    hash++;
    return {};
  };
  // The default pacing: the roster is read again after 250 ms.
  await Promise.all([
    ...[1, 2, 3].map((n) =>
      patchConfig(client, () => ({
        patch: { agents: { defaults: { maxConcurrent: n } } },
      })),
    ),
    configWrite(client, () => client.call("agents.update", { baseHash: `h${hash}` })),
  ]);
  assert.deepEqual(client.calls, [
    "agents.list",
    "agents.list",
    ...Array(3).fill(["config.get", "config.patch"]).flat(),
    "agents.update",
  ]);
  assert.equal(hash, 4);
  // A failed write does not stop the next one.
  await assert.rejects(configWrite(client, async () => assert.fail("refused")));
  assert.equal(await configWrite(client, async () => "next"), "next");
});

test("the agents still refused afterwards are degraded until the Gateway restarts", async () => {
  const client = gateway([
    { agents: [pending("ap-a"), pending("ap-b"), { id: "ap-c", status: "degraded" }] },
    { agents: [failed("ap-a"), { id: "ap-b" }, { id: "ap-c", status: "degraded" }] },
  ]);
  assert.equal(await admissionDone(client), true);
  // Only an admission refusal counts, not another degraded status.
  assert.deepEqual([...degradedAgents(client)], ["ap-a"]);
  assert.equal(agentDegraded(client, "ap-a"), true);
  assert.equal(agentDegraded(client, "ap-b"), false);
  // A new Gateway is a new client: nothing is degraded there.
  assert.equal(agentDegraded(gateway([{ agents: [] }]), "ap-a"), false);
  // A reconnect forgets them until the roster says so again.
  client.emit("disconnected");
  assert.equal(agentDegraded(client, "ap-a"), false);
  assert.equal(await admissionDone(gateway([{ agents: [{ id: "ap-a" }] }])), false);
});

test("the wait ends only without progress, and the roster is still watched", async () => {
  const warnings = [];
  const options = { ...clock(), timeoutMs: 5000, warn: (line) => warnings.push(line) };
  // Each agent admitted gives the rest the whole wait again.
  const slow = gateway([
    // Read at 0, 250, 750 and 1750 ms, then at 3750, 5750 and 7750 ms.
    ...Array(4).fill({ agents: [pending("ap-a"), pending("ap-b")] }),
    ...Array(3).fill({ agents: [pending("ap-b")] }),
    { agents: [{ id: "ap-a" }, { id: "ap-b" }] },
  ]);
  await settledAdmission(slow, options);
  // Admitted at 9750 ms, beyond 5000 ms after the start.
  assert.deepEqual(warnings, []);
  assert.equal(slow.calls.length, 8);
  // Without progress the writes go on; agents refused later are still found.
  const stuck = gateway([
    ...Array(10).fill({ agents: [pending("ap-a")] }),
    { agents: [failed("ap-a")] },
  ]);
  await settledAdmission(stuck, options);
  assert.match(warnings.join(), /5000 ms/);
  assert.doesNotMatch(warnings.join(), /ap-a/);
  assert.ok(stuck.calls.length < 10);
  await admissionDone(stuck);
  assert.equal(agentDegraded(stuck, "ap-a"), true);
  assert.equal(warnings.length, 1);
});

test("a Gateway that cannot answer yet is asked again; a closed one never blocks", async () => {
  const options = clock();
  const starting = gateway([
    answered("UNAVAILABLE"),
    Object.assign(Error("timeout"), { code: "TIMEOUT" }),
    { agents: [] },
  ]);
  starting.ready = true;
  await settledAdmission(starting, options);
  assert.equal(starting.calls.length, 3);
  const closed = gateway([Object.assign(Error("closed"), { code: "UNAVAILABLE" })]);
  closed.ready = false;
  await settledAdmission(closed, options);
  await settledAdmission(closed, options);
  assert.equal(closed.calls.length, 2);
  // A Gateway without this roster has no admission to wait for.
  const older = gateway([answered("INVALID_REQUEST")]);
  await settledAdmission(older, options);
  assert.equal(older.calls.length, 1);
  await settledAdmission(null);
  assert.equal(degradedAgents(null).size, 0);
});

test("a refusal a call reported marks its agent degraded; a pending one does not", () => {
  const client = gateway([{ agents: [] }]);
  const refusal = (code) =>
    answered("UNAVAILABLE", { admissionRefusal: { agentId: "ap-a", code } });
  assert.equal(noteRefusal(client, answered("UNAVAILABLE")), null);
  noteRefusal(client, refusal("agent-database-inspection-pending"));
  assert.equal(agentDegraded(client, "ap-a"), false);
  noteRefusal(client, refusal("agent-database-inspection-failed"));
  assert.equal(agentDegraded(client, "ap-a"), true);
});

test("only a definite answer before any run refuses a turn", () => {
  const refusal = (code) => ({ admissionRefusal: { agentId: "ap-a", code } });
  assert.equal(
    sendRefusal(answered("UNAVAILABLE", refusal("agent-database-inspection-failed"))),
    "degraded",
  );
  assert.equal(
    sendRefusal(
      answered("UNAVAILABLE", {
        retryable: true,
        ...refusal("agent-database-inspection-pending"),
      }),
    ),
    "starting",
  );
  assert.equal(sendRefusal(answered("UNAVAILABLE", { retryable: false })), "refused");
  assert.equal(sendRefusal(answered("INVALID_REQUEST")), "refused");
  // A handler's failure, a timeout and a lost connection leave the outcome open.
  assert.equal(sendRefusal(answered("UNAVAILABLE")), null);
  assert.equal(sendRefusal(Object.assign(Error(), { code: "TIMEOUT" })), null);
  assert.equal(sendRefusal(Object.assign(Error(), { code: "UNAVAILABLE" })), null);
  assert.equal(sendRefusal(undefined), null);
});

test("the owner's list names degraded agents and their chats before session faults", async () => {
  const client = gateway([{ agents: [failed("ap-a"), { id: "ap-b" }] }]);
  await settledAdmission(client, clock());
  const service = {
    runtime: { client },
    sessionFailures: new Map([
      ["c-a", { diagnostic: "SESSION_UNAVAILABLE" }],
      ["c-b", { diagnostic: "SESSION_UNAVAILABLE" }],
    ]),
  };
  const view = withAdmission(service, {
    assistants: [
      { id: "a", runtimeAgentId: "ap-a" },
      { id: "b", runtimeAgentId: "ap-b" },
    ],
    conversations: [
      { id: "c-a", assistantId: "a" },
      { id: "c-a2", assistantId: "a" },
      { id: "c-b", assistantId: "b" },
      { id: "c-b2", assistantId: "b" },
    ],
  });
  assert.deepEqual(
    view.assistants.map((a) => a.degraded),
    [true, undefined],
  );
  assert.deepEqual(
    view.conversations.map((c) => c.diagnostic),
    ["AGENT_DEGRADED", "AGENT_DEGRADED", "SESSION_UNAVAILABLE", undefined],
  );
});
