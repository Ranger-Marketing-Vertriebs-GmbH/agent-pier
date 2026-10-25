import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  agentDegraded,
  degradedAgents,
  noteRefusal,
  settledAdmission,
  withAdmission,
} from "../../server/features/assistants/agent-admission.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
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

test("a patch waits for the admission, and concurrent writers share the wait", async () => {
  const client = gateway([{ agents: [pending("ap-a")] }, { agents: [{ id: "ap-a" }] }]);
  client.answer = (method) => (method === "config.get" ? { hash: "h", config: {} } : {});
  // The default pacing: the roster is read again after 250 ms.
  await Promise.all(
    [1, 2].map((n) =>
      patchConfig(client, () => ({
        patch: { agents: { defaults: { maxConcurrent: n } } },
      })),
    ),
  );
  assert.deepEqual(client.calls, [
    "agents.list",
    "agents.list",
    "config.get",
    "config.get",
    "config.patch",
    "config.patch",
  ]);
});

test("the agents still refused afterwards are degraded until the Gateway restarts", async () => {
  const client = gateway([
    { agents: [pending("ap-a"), pending("ap-b")] },
    { agents: [failed("ap-a"), { id: "ap-b" }] },
  ]);
  await settledAdmission(client, clock());
  assert.deepEqual([...degradedAgents(client)], ["ap-a"]);
  assert.equal(agentDegraded(client, "ap-a"), true);
  assert.equal(agentDegraded(client, "ap-b"), false);
  // A new Gateway is a new client: nothing is degraded there.
  assert.equal(agentDegraded(gateway([{ agents: [] }]), "ap-a"), false);
});

test("the wait is bounded and a Gateway still starting is asked again", async () => {
  const warnings = [];
  const options = { ...clock(), timeoutMs: 5000, warn: (line) => warnings.push(line) };
  const starting = gateway([answered("UNAVAILABLE"), { agents: [] }]);
  await settledAdmission(starting, options);
  assert.deepEqual(starting.calls, ["agents.list", "agents.list"]);
  const stuck = gateway([{ agents: [pending("ap-a")] }]);
  await settledAdmission(stuck, options);
  assert.ok(stuck.calls.length > 2);
  assert.match(warnings.join(), /5000 ms/);
  assert.doesNotMatch(warnings.join(), /ap-a/);
});

test("a failed roster read never blocks a write and is asked again next time", async () => {
  const client = gateway([Object.assign(Error("closed"), { code: "UNAVAILABLE" })]);
  await settledAdmission(client, clock());
  await settledAdmission(client, clock());
  assert.equal(client.calls.length, 2);
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
