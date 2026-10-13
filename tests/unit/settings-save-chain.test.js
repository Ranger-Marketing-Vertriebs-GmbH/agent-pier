import test from "node:test";
import assert from "node:assert/strict";
import {
  completedLabels,
  confirmationRequest,
  isConflict,
  runSaveChain,
} from "../../web/lib/settings/save-chain.js";

const base = { name: "Home", memory: false, team: 4 };
const conflict = () =>
  Object.assign(new Error("changed"), { status: 409, messageKey: "assistants.conflict" });

function steps(log, { failTeam = false } = {}) {
  return [
    {
      id: "agent",
      label: "Profil",
      keys: ["name", "memory"],
      resource: "agent",
      run: async ({ values, revision }) => {
        log.push(["agent", values.name, revision]);
        return { revision: revision + 1 };
      },
    },
    {
      id: "team",
      label: "Team",
      keys: ["team"],
      resource: "team",
      run: async ({ values, revision, results }) => {
        log.push(["team", values.team, revision, results.agent?.revision]);
        if (failTeam) throw new Error("Team failed");
        return { revision: revision + 1 };
      },
    },
  ];
}

test("steps run in order, pass revisions on and skip unchanged fields", async () => {
  const log = [];
  const result = await runSaveChain({
    steps: steps(log),
    values: { ...base, name: "Office" },
    base,
    revisions: { agent: 3, team: 7 },
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(log, [["agent", "Office", 3]]);
  assert.deepEqual(result.completed, ["agent"]);
  assert.deepEqual(result.savedKeys, ["name", "memory"]);
  assert.deepEqual(result.revisions, { agent: 4, team: 7 });
});

test("the chain stops at the first error and reports the partial save", async () => {
  const log = [];
  const all = steps(log, { failTeam: true });
  const result = await runSaveChain({
    steps: all,
    values: { ...base, name: "Office", team: 6 },
    base,
    revisions: { agent: 3, team: 7 },
  });
  assert.equal(result.status, "error");
  assert.equal(result.failedStep, "team");
  assert.equal(result.error.message, "Team failed");
  assert.deepEqual(result.savedKeys, ["name", "memory"]);
  assert.deepEqual(completedLabels(all, result), ["Profil"]);
  assert.deepEqual(log[1], ["team", 6, 7, 4]);
});

test("a retry after a partial save skips the step that already finished", async () => {
  const log = [];
  const values = { ...base, name: "Office", team: 6 };
  const first = await runSaveChain({
    steps: steps(log, { failTeam: true }),
    values,
    base,
    revisions: { agent: 3, team: 7 },
  });
  const savedBase = { ...base, name: "Office" };
  const second = await runSaveChain({
    steps: steps(log),
    values,
    base: savedBase,
    revisions: first.revisions,
  });
  assert.equal(second.status, "saved");
  assert.deepEqual(
    log.map(([id]) => id),
    ["agent", "team", "team"],
  );
  assert.deepEqual(second.revisions, { agent: 4, team: 8 });
});

test("a confirmation repeats the same step with the confirmed flag", async () => {
  const bodies = [];
  const step = {
    id: "agent",
    label: "Fähigkeiten",
    keys: ["memory"],
    resource: "agent",
    run: async ({ confirmations, revision }) => {
      bodies.push({ ...confirmations, revision });
      if (!confirmations.confirmRestart)
        throw Object.assign(new Error("restart"), {
          status: 409,
          code: "ASSISTANT_RESTART_REQUIRED",
          affected: { agents: [{ id: "a", name: "A" }] },
        });
      return { revision: revision + 1 };
    },
  };
  const asked = [];
  const result = await runSaveChain({
    steps: [step],
    values: { ...base, memory: true },
    base,
    revisions: { agent: 1 },
    ask: async (request) => {
      asked.push(request);
      return true;
    },
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(bodies, [{ revision: 1 }, { confirmRestart: true, revision: 1 }]);
  assert.equal(asked[0].kind, "restart");
  assert.equal(asked[0].stepId, "agent");
  assert.deepEqual(asked[0].data.affected.agents, [{ id: "a", name: "A" }]);
});

test("a declined confirmation cancels and a repeated request is an error", async () => {
  const restart = () =>
    Object.assign(new Error("restart"), { code: "ASSISTANT_RESTART_REQUIRED" });
  const step = {
    id: "agent",
    label: "A",
    keys: ["memory"],
    run: async () => {
      throw restart();
    },
  };
  const input = { steps: [step], values: { ...base, memory: true }, base };
  assert.equal(
    (await runSaveChain({ ...input, ask: async () => false })).status,
    "cancelled",
  );
  const repeated = await runSaveChain({ ...input, ask: async () => true });
  assert.equal(repeated.status, "error");
  assert.equal(repeated.error.code, "ASSISTANT_RESTART_REQUIRED");
});

test("a stale revision is reported as a conflict", async () => {
  const step = {
    id: "agent",
    label: "A",
    keys: ["name"],
    run: async () => {
      throw conflict();
    },
  };
  const result = await runSaveChain({
    steps: [step],
    values: { ...base, name: "Office" },
    base,
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.failedStep, "agent");
  assert.equal(isConflict(conflict()), true);
  assert.equal(isConflict(Object.assign(new Error(), { status: 409 })), false);
});

test("only an exact conflict key is a revision conflict", () => {
  const refused = (messageKey) =>
    Object.assign(new Error("refused"), { status: 409, messageKey });
  assert.equal(isConflict(refused("mcpServers.conflict")), true);
  for (const key of [
    "mcpServers.cliNotConflict",
    "mcpServers.cliStatusConflict",
    "accounts.apiKeyLoginConflict",
  ])
    assert.equal(isConflict(refused(key)), false, key);
});

test("a capacity overflow is an error, not a conflict", async () => {
  const capacity = Object.assign(new Error("full"), {
    status: 409,
    messageKey: "assistants.capacity",
  });
  assert.equal(isConflict(capacity), false);
  const step = {
    id: "team",
    label: "T",
    keys: ["team"],
    run: async () => {
      throw capacity;
    },
  };
  const result = await runSaveChain({
    steps: [step],
    values: { ...base, team: 9 },
    base,
  });
  assert.equal(result.status, "error");
  assert.equal(result.error.messageKey, "assistants.capacity");
});

test("shell and stdio confirmations map to their flags", () => {
  assert.deepEqual(
    confirmationRequest({
      code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
      required: ["confirmFull"],
    }),
    {
      kind: "fullShell",
      flags: { confirmFull: true },
      data: { required: ["confirmFull"] },
    },
  );
  assert.deepEqual(confirmationRequest({ code: "MCP_STDIO_CONFIRMATION_REQUIRED" }), {
    kind: "stdio",
    flags: { confirmStdio: true },
  });
  assert.equal(confirmationRequest(new Error("other")), null);
});
