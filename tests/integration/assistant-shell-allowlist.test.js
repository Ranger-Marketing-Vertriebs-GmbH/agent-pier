import test from "node:test";
import assert from "node:assert/strict";
import {
  execFixture,
  gatewayError,
  staleHash,
} from "../helpers/assistant-exec-fixture.js";
import { ExecAllowlist } from "../../server/features/assistants/exec-allowlist.js";
import { ShellChanges } from "../../server/features/assistants/shell-changes.js";
import {
  cwdArgvPattern,
  nodeCommandPattern,
} from "../../server/features/assistants/exec-allowlist-links.js";

const argPattern = `sha256:cwd-argv:v1:${"a".repeat(64)}`;
const openclaw = [
  {
    id: "oc-path",
    pattern: "/usr/bin/touch",
    source: "allow-always",
    argPattern,
    lastUsedAt: 1760000000000,
  },
  { id: "oc-cmd", pattern: "=node-command:0123456789abcdef", source: "allow-always" },
  { id: "manual", pattern: "/bin/ls" },
];

// A Gateway approvals document whose hash changes with every write; `stale` makes
// that many next writes fail as if a run had changed it in between.
function approvals(f, file) {
  const state = { file, hash: 1, stale: 0, sets: [] };
  f.gateway.answers["exec.approvals.get"] = () => ({
    file: structuredClone(state.file),
    hash: `h${state.hash}`,
  });
  f.gateway.answers["exec.approvals.set"] = (params) => {
    state.sets.push(params);
    if (state.stale > 0) {
      state.stale--;
      state.hash++;
      throw staleHash();
    }
    if (params.baseHash !== `h${state.hash}`) throw staleHash();
    state.file = params.file;
    state.hash++;
    return { file: state.file, hash: `h${state.hash}` };
  };
  return state;
}

test("the allowlist lists every entry and deletes one by id", async (t) => {
  const f = await execFixture(t);
  f.assistants.audit = { append: (entry) => f.audit.push(entry) };
  const agentId = f.agent.runtimeAgentId;
  const state = approvals(f, {
    version: 1,
    agents: {
      [agentId]: { allowlist: [...openclaw] },
      other: { allowlist: [{ id: "x", pattern: "/bin/cat" }] },
    },
  });
  // AgentPier writes a program entry for a withheld allow-always (exec-decisions.js).
  const tool = f.program("tool");
  const action = await f.request("ours", {
    command: `${tool} --build`,
    cwd: "/work/app",
    resolvedPath: tool,
    allowedDecisions: ["allow-once", "deny"],
  });
  await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "allow-always" },
    { kind: "owner" },
  );
  const ours = state.file.agents[agentId].allowlist.at(-1);
  assert.equal(ours.pattern, tool);
  const allowlist = new ExecAllowlist(f.assistants);
  const listed = await allowlist.list(f.id);
  assert.deepEqual(listed.entries, [
    {
      id: "oc-path",
      pattern: "/usr/bin/touch",
      argPattern,
      source: "openclaw",
      kind: "program",
      lastUsedAt: 1760000000000,
    },
    {
      id: "oc-cmd",
      pattern: "=node-command:0123456789abcdef",
      source: "openclaw",
      kind: "command",
    },
    { id: "manual", pattern: "/bin/ls", source: "other", kind: "program" },
    {
      id: ours.id,
      pattern: tool,
      source: "agentpier",
      kind: "program",
      command: `${tool} --build`,
      cwd: "/work/app",
      requestedAt: action.createdAt,
    },
  ]);

  const sets = state.sets.length;
  const removed = await allowlist.remove(f.id, "oc-path");
  assert.equal(removed.removed, "oc-path");
  assert.deepEqual(
    removed.entries.map((e) => e.id),
    ["oc-cmd", "manual", ours.id],
  );
  assert.equal(state.sets.length, sets + 1);
  // The write carries the current hash and leaves every other entry and agent alone.
  assert.deepEqual(state.file.agents.other, {
    allowlist: [{ id: "x", pattern: "/bin/cat" }],
  });
  assert.deepEqual(
    state.file.agents[agentId].allowlist.map((e) => e.id),
    ["oc-cmd", "manual", ours.id],
  );
  assert.deepEqual(
    (await allowlist.list(f.id)).entries.map((e) => e.id),
    ["oc-cmd", "manual", ours.id],
  );
  assert.deepEqual(f.audit.at(-1), {
    action: "assistant.revoked",
    resourceType: "assistant",
    resourceId: f.id,
    source: "user",
    outcome: "success",
    details: { kind: "allowlist", entryId: "oc-path" },
  });

  // An unknown entry is 404 and writes nothing.
  await assert.rejects(allowlist.remove(f.id, "oc-path"), {
    status: 404,
    key: "allowlistEntryNotFound",
  });
  assert.equal(state.sets.length, sets + 1);
  // A run between read and write: one retry with a fresh read, then 409.
  state.stale = 1;
  await allowlist.remove(f.id, "manual");
  assert.equal(state.sets.length, sets + 3);
  assert.deepEqual(
    state.file.agents[agentId].allowlist.map((e) => e.id),
    ["oc-cmd", ours.id],
  );
  state.stale = 2;
  await assert.rejects(allowlist.remove(f.id, ours.id), { status: 409, key: "conflict" });
  assert.equal(state.sets.length, sets + 5);
  assert.equal(state.file.agents[agentId].allowlist.length, 2);
  // Any other Gateway failure is unavailable; so is a Gateway that is not ready.
  f.gateway.answers["exec.approvals.set"] = gatewayError("UNAVAILABLE", "down");
  await assert.rejects(allowlist.remove(f.id, ours.id), { status: 503 });
  f.gateway.ready = false;
  await assert.rejects(allowlist.list(f.id), { status: 503 });
});

test("an agent without entries lists none", async (t) => {
  const f = await execFixture(t);
  f.gateway.answers["exec.approvals.get"] = { file: { version: 1 }, hash: "h" };
  assert.deepEqual(await new ExecAllowlist(f.assistants).list(f.id), { entries: [] });
});

test("turning shell off denies the agent's exec requests still awaiting the owner", async (t) => {
  const f = await execFixture(t);
  const decided = await f.request("decided");
  await f.workflows.decide(
    decided.id,
    { revision: decided.revision, decision: "allow-once" },
    { kind: "owner" },
  );
  const first = await f.request("first");
  const gone = await f.request("gone");
  // The Gateway no longer has the second one: it still ends here.
  f.gateway.answers["exec.approval.resolve"] = (params) => {
    if (params.id === "gone")
      throw gatewayError("INVALID_REQUEST", "unknown approval id");
    return {};
  };
  const agent = f.store.getAssistant(f.id);
  f.store.updateAssistant(f.id, { shell: "off" }, agent.revision);
  const before = f.decisions().length;
  const denied = await new ShellChanges(f.assistants).denyPending(f.id);
  assert.equal(denied, 2);
  assert.deepEqual(f.resolves().slice(-2), [
    { id: "first", decision: "deny" },
    { id: "gone", decision: "deny" },
  ]);
  for (const action of [first, gone]) {
    const current = f.workflows.get(action.id);
    assert.equal(current.state, "declined");
    assert.deepEqual(current.result, { decision: "deny" });
    assert.equal(current.diagnostic, "SHELL_OFF");
  }
  assert.equal(f.workflows.get(decided.id).state, "completed");
  assert.equal(f.workflows.get(decided.id).diagnostic, undefined);
  // Each deny is an audited owner decision.
  assert.deepEqual(
    f
      .decisions()
      .slice(before)
      .map((d) => [d.decision, d.outcome]),
    [
      ["deny", "success"],
      ["deny", "failure"],
    ],
  );
  // A request arriving now is denied at once (exec-approvals.js).
  await f.request("late");
  assert.deepEqual(f.resolves().at(-1), { id: "late", decision: "deny" });
});

test("OpenClaw's companion folds into its path entry and is deleted with it", async (t) => {
  const f = await execFixture(t);
  f.assistants.audit = { append: (entry) => f.audit.push(entry) };
  const agentId = f.agent.runtimeAgentId;
  const command = "/usr/bin/touch /work/x";
  // OpenClaw answered this allow-always itself (it offered allow-always).
  const action = await f.request("theirs", {
    command,
    cwd: "/work",
    resolvedPath: "/usr/bin/touch",
  });
  await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "allow-always" },
    { kind: "owner" },
  );
  const path = {
    id: "path",
    pattern: "/usr/bin/touch",
    source: "allow-always",
    argPattern: cwdArgvPattern(["/usr/bin/touch", "/work/x"], "/work"),
  };
  const twin = {
    id: "twin",
    pattern: nodeCommandPattern(command),
    source: "allow-always",
  };
  const orphan = {
    id: "orphan",
    pattern: nodeCommandPattern("ls"),
    source: "allow-always",
  };
  const state = approvals(f, {
    version: 1,
    agents: { [agentId]: { allowlist: [path, twin, orphan] } },
  });
  const allowlist = new ExecAllowlist(f.assistants);
  assert.deepEqual((await allowlist.list(f.id)).entries, [
    {
      id: "path",
      pattern: "/usr/bin/touch",
      argPattern: path.argPattern,
      source: "openclaw",
      kind: "program",
      command,
      cwd: "/work",
      requestedAt: action.createdAt,
      companions: ["twin"],
    },
    // A companion AgentPier cannot place stays visible and removable.
    { id: "orphan", pattern: orphan.pattern, source: "openclaw", kind: "command" },
  ]);
  const removed = await allowlist.remove(f.id, "path");
  assert.deepEqual(removed.companions, ["twin"]);
  assert.deepEqual(
    state.file.agents[agentId].allowlist.map((e) => e.id),
    ["orphan"],
  );
  assert.deepEqual(f.audit.at(-1).details, {
    kind: "allowlist",
    entryId: "path",
    count: 1,
  });
  await allowlist.remove(f.id, "orphan");
  assert.deepEqual(state.file.agents[agentId].allowlist, []);
});

test("with shell off no exec request can be allowed any more", async (t) => {
  const f = await execFixture(t);
  const action = await f.request("late-allow");
  f.store.updateAssistant(f.id, { shell: "off" }, f.store.getAssistant(f.id).revision);
  for (const decision of ["allow-once", "allow-always"])
    await assert.rejects(
      f.workflows.decide(
        action.id,
        { revision: action.revision, decision },
        { kind: "owner" },
      ),
      { status: 409 },
    );
  assert.deepEqual(f.resolves(), []);
  const denied = await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "deny" },
    { kind: "owner" },
  );
  assert.equal(denied.state, "declined");
});
