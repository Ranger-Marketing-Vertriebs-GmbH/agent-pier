import test from "node:test";
import assert from "node:assert/strict";
import { execFixture } from "../helpers/assistant-exec-fixture.js";
import { ExecAllowlist } from "../../server/features/assistants/exec-allowlist.js";
import {
  commandHash,
  rememberedCommands,
  rememberedId,
} from "../../server/features/assistants/exec-remembered.js";

// AGENTPIER-276: "Always allow" on a command OpenClaw cannot allowlist (an
// interpreter, an inline script, shell syntax) used to allow it once only, so the
// same command asked again. AgentPier now remembers exactly that command: the
// identical command runs again without a card, any other command still asks.
const withheld = { allowedDecisions: ["allow-once", "deny"] };

async function remembered(t) {
  const f = await execFixture(t);
  f.gateway.answers["exec.approval.resolve"] = {};
  f.gateway.answers["exec.approvals.get"] = { file: { version: 1 }, hash: "h" };
  const first = await f.request("a1", { command: "node build.js", ...withheld });
  assert.equal(first.payload.commandHash, commandHash("node build.js"));
  await f.workflows.decide(
    first.id,
    { revision: first.revision, decision: "allow-always" },
    { kind: "owner" },
  );
  return f;
}

test("the identical command runs again without a card", async (t) => {
  const f = await remembered(t);
  const again = await f.request("a2", { command: "node build.js", ...withheld });
  assert.equal(again.state, "completed");
  assert.equal(again.result.by, "remembered");
  assert.equal(again.result.allowlist.remembered, true);
  assert.deepEqual(f.resolves().at(-1), { id: "a2", decision: "allow-once" });
  // Nothing broader: other arguments, another command and an inline variant ask.
  for (const [id, command] of [
    ["a3", "node build.js --watch"],
    ["a4", "node other.js"],
    ["a5", " node build.js"],
  ]) {
    const asked = await f.request(id, { command, ...withheld });
    assert.equal(asked.state, "awaiting_approval", command);
  }
  assert.equal(
    f.gateway.calls.some((c) => c.method === "exec.approvals.set"),
    false,
    "no program-wide entry",
  );
});

test("another agent and a shortened command never use it", async (t) => {
  const f = await remembered(t);
  const store = rememberedCommands(f.store.db);
  assert.equal(store.has(f.id, commandHash("node build.js")), true);
  assert.equal(store.has("another-agent", commandHash("node build.js")), false);
  // A shortened command carries no hash, so it is never remembered.
  const long = `node ${"x".repeat(40000)}.js`;
  const shortened = await f.request("a6", { command: long, ...withheld });
  assert.equal(shortened.payload.commandHash, undefined);
  assert.equal(shortened.allowAlwaysPlan.reason, "complex");
});

test("the owner sees and deletes a remembered command among the allowed commands", async (t) => {
  const f = await remembered(t);
  f.assistants.admit = async (fn) => fn();
  f.assistants.changed = () => {};
  const allowlist = new ExecAllowlist(f.assistants);
  const id = rememberedId(commandHash("node build.js"));
  const { entries } = await allowlist.list(f.id);
  assert.deepEqual(
    entries.map(({ id: entry, source, kind, command, cwd }) => ({
      entry,
      source,
      kind,
      command,
      cwd,
    })),
    [
      {
        entry: id,
        source: "agentpier",
        kind: "command",
        command: "node build.js",
        cwd: "/work",
      },
    ],
  );
  const removed = await allowlist.remove(f.id, id);
  assert.equal(removed.removed, id);
  assert.deepEqual(removed.entries, []);
  await assert.rejects(allowlist.remove(f.id, id), { status: 404 });
  const asked = await f.request("a7", { command: "node build.js", ...withheld });
  assert.equal(asked.state, "awaiting_approval");
});
