import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import {
  DEFAULT_RUNTIME,
  RUNTIME_CAPABILITIES,
} from "../../server/features/assistants/runtimes/agent-runtime.js";
import {
  RUNTIME_IDS,
  assertRuntime,
  knownRuntime,
  runtimeDetails,
  runtimeFor,
  runtimeIdOf,
  withRuntime,
} from "../../server/features/assistants/runtimes/runtime-for.js";

// ADR 0006, decision 1: every agent records the runtime it runs on, OpenClaw by default.
const model = { connectionId: "c", modelId: "m" };
function storeDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-field-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}
const supervisor = (version = "2026.10.3") => ({
  client: { ready: true },
  status: () => ({ availability: "ready", sync: "live", version, diagnostic: null }),
});

test("a new agent records OpenClaw, or the known runtime it chose", (t) => {
  const store = new AssistantStore({ dataDir: storeDir(t) });
  t.after(() => store.close());
  const plain = store.createAssistant({ name: "A", model });
  assert.equal(plain.runtime, "openclaw");
  const chosen = store.createAssistant({ name: "B", model, runtime: "openclaw" });
  assert.equal(store.getAssistant(chosen.id).runtime, "openclaw");
  assert.equal(
    store.createAssistant({ name: "H", model, runtime: "hermes" }).runtime,
    "hermes",
  );
  assert.throws(() => store.createAssistant({ name: "C", model, runtime: "mystery" }), {
    status: 400,
    key: "runtimeUnknown",
  });
  assert.throws(() => store.createAssistant({ name: "D", model, runtime: 7 }), {
    status: 400,
    key: "invalid",
  });
  // The runtime is chosen at creation; a later edit cannot move the agent.
  assert.throws(() => store.updateAssistant(plain.id, { runtime: "openclaw" }, 1), {
    status: 400,
    key: "invalid",
  });
  assert.equal(store.listAssistants().length, 3);
});

test("opening a store from before the field gives every agent OpenClaw", (t) => {
  const dataDir = storeDir(t);
  let store = new AssistantStore({ dataDir });
  const lead = store.createAssistant({ name: "Lead", model });
  store.reserveMember({
    id: "member-1",
    parent: lead.id,
    assignment: { name: "Helper" },
    snapshot: { model, instructions: "" },
    teamId: "team-1",
    lifetime: "task",
  });
  store.close();
  // An older build (or a backup it wrote) stored agents without `runtime`.
  const db = new DatabaseSync(path.join(dataDir, "assistants", "assistants.sqlite"));
  for (const row of db.prepare("SELECT id, body FROM assistants").all()) {
    const { runtime: _runtime, ...body } = JSON.parse(row.body);
    db.prepare("UPDATE assistants SET body=? WHERE id=?").run(
      JSON.stringify(body),
      row.id,
    );
  }
  db.prepare("INSERT INTO assistants VALUES (?,?,?)").run(
    "old",
    3,
    JSON.stringify({ id: "old", name: "Old", model, revision: 3 }),
  );
  db.close();
  store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const raw = (id) => store.storedAssistant(id);
  assert.equal(raw("old").runtime, "openclaw");
  assert.equal(raw("old").revision, 3, "the migration is no edit");
  assert.equal(raw(lead.id).runtime, "openclaw");
  // A member keeps none of its own: it runs on its lead's.
  assert.equal("runtime" in raw("member-1"), false);
  assert.equal(store.getAssistant("member-1").runtime, "openclaw");
  // Reopening changes nothing more.
  store.close();
  store = new AssistantStore({ dataDir });
  assert.equal(raw("old").runtime, "openclaw");
});

test("a team member runs on its lead's runtime unless one is set for it", (t) => {
  const dataDir = storeDir(t);
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const lead = store.createAssistant({ name: "Lead", model });
  // A lead of a runtime a later AgentPier ships: its members follow it.
  store.changeUserAgent(lead.id, { runtime: "later" });
  const member = store.reserveMember({
    id: "member-2",
    parent: lead.id,
    assignment: { name: "Helper" },
    snapshot: { model, instructions: "" },
    teamId: "team-1",
    lifetime: "permanent",
  });
  assert.equal("runtime" in member, false);
  assert.equal(store.getAssistant(member.id).runtime, "later");
  assert.equal(store.listAssistants().find((a) => a.id === member.id).runtime, "later");
  // Writes never persist the inherited runtime.
  store.markEffective(member.id, 1);
  store.updateAssistant(member.id, { name: "Helper 2" }, 1);
  assert.equal("runtime" in store.storedAssistant(member.id), false);
  // A runtime set for the member is its own.
  store.changeUserAgent(member.id, { runtime: "openclaw" });
  assert.equal(store.getAssistant(member.id).runtime, "openclaw");
});

test("runtimeFor picks the adapter by the agent's runtime and refuses unknown ones", () => {
  assert.equal(DEFAULT_RUNTIME, "openclaw");
  assert.deepEqual(RUNTIME_IDS, ["openclaw", "hermes"]);
  assert.equal(runtimeIdOf(null), "openclaw");
  assert.equal(runtimeIdOf({ id: "a" }), "openclaw");
  assert.equal(runtimeIdOf({ runtime: "hermes" }), "hermes");
  assert.equal(knownRuntime("openclaw"), true);
  assert.equal(knownRuntime("hermes"), true);
  assert.equal(knownRuntime("mystery"), false);
  assert.equal(knownRuntime("constructor"), false);
  assert.equal(assertRuntime("openclaw"), "openclaw");
  const host = supervisor();
  assert.equal(runtimeFor({ runtime: "openclaw" }, host).id, "openclaw");
  assert.equal(runtimeFor({ runtime: "openclaw" }, host), runtimeFor(null, host));
  // A Hermes agent runs on its own process set, one runtime per agent.
  const hermes = runtimeFor({ runtime: "hermes", runtimeAgentId: "ap-h1" }, host);
  assert.equal(hermes.id, "hermes");
  assert.equal(runtimeFor({ runtime: "hermes", id: "h1" }, host), hermes);
  assert.notEqual(
    runtimeFor({ runtime: "hermes", runtimeAgentId: "ap-h2" }, host),
    hermes,
  );
  assert.throws(
    () => runtimeFor({ runtime: "mystery" }, host),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.key, "runtimeUnknown");
      assert.match(error.message, /„mystery“/);
      return true;
    },
  );
});

test("runtimeDetails names the runtime, its version and its capabilities", () => {
  const details = runtimeDetails({ runtime: "openclaw" }, supervisor());
  assert.equal(details.id, "openclaw");
  assert.equal(details.name, "OpenClaw");
  assert.equal(details.version, "2026.10.3");
  assert.deepEqual(Object.keys(details.capabilities), [...RUNTIME_CAPABILITIES]);
  // OpenClaw offers everything but the Hermes-only "Every command" level.
  for (const [name, capability] of Object.entries(details.capabilities))
    assert.deepEqual(
      capability,
      name === "everyCommandApproval"
        ? { available: false, reason: "approvalAsksEveryCommand" }
        : { available: true },
      name,
    );
  const hermes = runtimeDetails(
    { runtime: "hermes", runtimeAgentId: "ap-h" },
    supervisor(),
  );
  assert.equal(hermes.name, "Hermes Agent");
  assert.equal(hermes.version, null);
  assert.deepEqual(hermes.capabilities.routines, { available: true });
  assert.deepEqual(hermes.capabilities.skills, { available: true });
  assert.deepEqual(hermes.capabilities.browser, {
    available: false,
    reason: "hermesNotYetSupported",
  });
  // A stopped host has no running version; a stand-in without status none either.
  assert.equal(runtimeDetails(null, supervisor(null)).version, null);
  assert.equal(runtimeDetails(null, { client: null }).version, null);
  // A runtime this AgentPier lacks is shown with the reason, never hidden.
  const missing = runtimeDetails({ runtime: "mystery" }, supervisor());
  assert.equal(missing.name, "mystery");
  assert.deepEqual(Object.keys(missing.capabilities), [...RUNTIME_CAPABILITIES]);
  for (const capability of Object.values(missing.capabilities))
    assert.deepEqual(capability, { available: false, reason: "runtimeUnknown" });
  const view = withRuntime({ id: "a", runtime: "openclaw" }, supervisor());
  assert.equal(view.runtimeInfo.name, "OpenClaw");
  assert.equal(view.id, "a");
});
