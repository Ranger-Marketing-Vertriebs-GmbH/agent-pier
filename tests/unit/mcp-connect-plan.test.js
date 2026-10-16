import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  AGENT_GONE,
  connectDiff,
  onlyTarget,
  ownerManaged,
  runConnect,
} from "../../web/features/mcp-servers/wizard/connect-plan.js";

const server = (extra = {}) => ({
  id: "s1",
  transport: "stdio",
  clis: [],
  revision: 1,
  ...extra,
});
const agent = (id, mcpServers = [], extra = {}) => ({
  id,
  name: id.toUpperCase(),
  mcpServers,
  revision: 1,
  ...extra,
});
const conflict = () =>
  Object.assign(new Error("changed"), { status: 409, messageKey: "assistants.conflict" });

/** A fake API over an agent table; `refuse(id, attempt)` may throw. */
function fakeApi({ agents, record = server(), refuse = () => null, cliError = null }) {
  const calls = [];
  const table = new Map(agents.map((a) => [a.id, structuredClone(a)]));
  const attempts = new Map();
  return {
    calls,
    table,
    api: {
      server: async () => record,
      updateServer: async (id, body) => {
        calls.push(["server", id, body]);
        if (cliError) throw cliError;
        return { ...record, clis: body.clis, revision: record.revision + 1 };
      },
      assistants: async () => [...table.values()].map((a) => structuredClone(a)),
      updateAssistant: async (id, body) => {
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        calls.push(["agent", id, body]);
        const error = refuse(id, attempt);
        if (error) throw error;
        const current = table.get(id);
        if (body.revision !== current.revision) throw conflict();
        table.set(id, {
          ...current,
          mcpServers: body.mcpServers,
          revision: current.revision + 1,
        });
        return table.get(id);
      },
    },
  };
}

test("owner-managed agents only: temporary and archived agents are left out", () => {
  const list = [agent("a"), { id: "t", name: "T" }, agent("x", [], { archivedAt: 1 })];
  assert.deepEqual(
    ownerManaged(list).map((a) => a.id),
    ["a"],
  );
});

test("the diff names added CLIs, changed agents and whether consent is needed", () => {
  const diff = connectDiff({
    server: server({ clis: ["codex"], cwd: "/w" }),
    clis: ["claude", "codex", "opencode"],
    agents: ["a"],
    assistants: [agent("a"), agent("b", ["s1"])],
  });
  assert.deepEqual(diff.clis, {
    changed: true,
    wanted: ["codex", "opencode"],
    added: ["opencode"],
  });
  assert.deepEqual(diff.agents, [
    { id: "a", name: "A", add: true },
    { id: "b", name: "B", add: false },
  ]);
  assert.equal(diff.needsConsent, true);
  const remote = connectDiff({
    server: server({ transport: "http" }),
    clis: ["claude"],
    agents: [],
    assistants: [],
  });
  assert.equal(remote.needsConsent, false);
  const removal = connectDiff({
    server: server({ clis: ["claude"] }),
    clis: [],
    agents: [],
    assistants: [agent("b", ["s1"])],
  });
  assert.equal(removal.needsConsent, false);
});

test("CLIs first with the fresh revision, then each agent; consent only where it adds", async () => {
  const fake = fakeApi({
    agents: [agent("a", ["other"]), agent("b", ["s1"])],
    record: server({ revision: 7 }),
  });
  const diff = connectDiff({
    server: server(),
    clis: ["claude"],
    agents: ["a"],
    assistants: [...fake.table.values()],
  });
  const results = await runConnect({
    diff,
    serverId: "s1",
    consented: true,
    api: fake.api,
  });
  assert.deepEqual(
    results.map((r) => [r.target.kind, r.target.id, r.ok]),
    [
      ["cli", undefined, true],
      ["agent", "a", true],
      ["agent", "b", true],
    ],
  );
  assert.deepEqual(fake.calls[0], [
    "server",
    "s1",
    { revision: 7, clis: ["claude"], confirmStdio: true },
  ]);
  assert.deepEqual(fake.calls[1][2], {
    mcpServers: ["other", "s1"],
    revision: 1,
    confirmStdio: true,
  });
  assert.deepEqual(fake.calls[2][2], { mcpServers: [], revision: 1 });
  assert.deepEqual(fake.table.get("a").mcpServers, ["other", "s1"]);
});

test("a CLI refusal does not hide agent results; a busy agent fails alone", async () => {
  const busy = Object.assign(new Error("busy"), {
    status: 409,
    messageKey: "assistants.active",
  });
  const fake = fakeApi({
    agents: [agent("a"), agent("b")],
    cliError: new Error("cli refused"),
    refuse: (id) => (id === "a" ? busy : null),
  });
  const diff = connectDiff({
    server: server(),
    clis: ["claude"],
    agents: ["a", "b"],
    assistants: [...fake.table.values()],
  });
  const results = await runConnect({
    diff,
    serverId: "s1",
    consented: true,
    api: fake.api,
  });
  assert.deepEqual(
    results.map((r) => r.ok),
    [false, false, true],
  );
  assert.equal(results[1].error, busy);
});

test("a revision conflict is read again once; a second one is reported", async () => {
  const once = fakeApi({
    agents: [agent("a")],
    refuse: (id, attempt) => (attempt === 1 ? conflict() : null),
  });
  const diff = connectDiff({
    server: server(),
    clis: [],
    agents: ["a"],
    assistants: [agent("a")],
  });
  const [result] = await runConnect({
    diff,
    serverId: "s1",
    consented: true,
    api: once.api,
  });
  assert.equal(result.ok, true);
  const twice = fakeApi({ agents: [agent("a")], refuse: () => conflict() });
  const [failed] = await runConnect({
    diff,
    serverId: "s1",
    consented: true,
    api: twice.api,
  });
  assert.equal(failed.ok, false);
  assert.equal(twice.calls.length, 2);
});

test("an agent that disappeared is reported as gone; one already bound is fine", async () => {
  const fake = fakeApi({ agents: [agent("b", ["s1"])] });
  const diff = {
    clis: { changed: false, wanted: [], added: [] },
    stdio: true,
    needsConsent: true,
    agents: [
      { id: "a", name: "A", add: true },
      { id: "b", name: "B", add: true },
    ],
  };
  const results = await runConnect({
    diff,
    serverId: "s1",
    consented: true,
    api: fake.api,
  });
  assert.equal(results[0].error.code, AGENT_GONE);
  assert.equal(results[1].ok, true);
  assert.equal(fake.calls.length, 0);
});

test("Try again restricts the diff to one target", () => {
  const diff = connectDiff({
    server: server(),
    clis: ["claude"],
    agents: ["a", "b"],
    assistants: [agent("a"), agent("b")],
  });
  assert.equal(onlyTarget(diff, { kind: "cli" }).agents.length, 0);
  const one = onlyTarget(diff, { kind: "agent", id: "b" });
  assert.equal(one.clis.changed, false);
  assert.deepEqual(
    one.agents.map((c) => c.id),
    ["b"],
  );
});

test("property: only the wizard's server is added or removed; other bindings stay", async () => {
  const ids = fc.constantFrom("s1", "s2", "s3", "s4");
  const agentArb = fc.record({
    bound: fc.uniqueArray(ids, { maxLength: 4 }),
    want: fc.boolean(),
  });
  await fc.assert(
    fc.asyncProperty(fc.array(agentArb, { maxLength: 6 }), async (rows) => {
      const agents = rows.map((row, index) => agent(`a${index}`, row.bound));
      const fake = fakeApi({ agents });
      const chosen = rows.flatMap((row, index) => (row.want ? [`a${index}`] : []));
      const diff = connectDiff({
        server: server(),
        clis: [],
        agents: chosen,
        assistants: agents,
      });
      await runConnect({ diff, serverId: "s1", consented: true, api: fake.api });
      rows.forEach((row, index) => {
        const after = fake.table.get(`a${index}`).mcpServers;
        const others = (list) => list.filter((id) => id !== "s1").sort();
        assert.deepEqual(others(after), others(row.bound));
        assert.equal(after.includes("s1"), row.want);
      });
    }),
  );
});
