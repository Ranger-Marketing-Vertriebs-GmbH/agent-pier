import test from "node:test";
import assert from "node:assert/strict";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { DatabaseSync } from "node:sqlite";
import {
  RoutineResults,
  withRoutineResults,
} from "../../server/features/assistants/routine-results.js";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { eventRowView, noteTexts } from "../../web/features/assistants/event-area.js";

// A routine whose write was refused because "May write" is off (AGENTPIER-269).
const routines = () => {
  const r = Object.create(NativeRoutines.prototype);
  r.refusals = new Map();
  r.recorded = [];
  r.results = { record: (entry) => r.recorded.push(entry) };
  r.conversation = () => ({ id: "chat" });
  return r;
};

test("a run whose write was refused ends ok, with the warning on its result", () => {
  const r = routines();
  const runAtMs = Date.now();
  r.noteRefusal("agent:ap-x:cron:job-1:run:abc", "writes_refused");
  r.completed(
    { id: "b", definition: { name: "Daily check" } },
    { jobId: "job-1", runAtMs, status: "ok", summary: "Checked; not saved." },
  );
  assert.equal(r.recorded[0].status, "ok");
  assert.deepEqual(r.recorded[0].notes, ["writes_refused"]);
  assert.equal(r.recorded[0].failure, undefined);
  const [message] = withRoutineResults([], r.recorded);
  assert.equal(message.role, "assistant");
  assert.deepEqual(message.scheduled.notes, ["writes_refused"]);
});

test("the owner's notice names the routine's May write switch", () => {
  setLanguage("en");
  assert.deepEqual(noteTexts(["writes_refused"]), [
    "Changes refused: “May write” is off for this routine",
  ]);
  const row = eventRowView({
    id: "routine:1",
    source: "routine",
    name: "Daily check",
    at: 1,
    status: "done",
    firstLine: "",
    notes: ["writes_refused"],
  });
  assert.match(row.detail, /“May write” is off/);
  assert.equal(row.tone, "ok");
  setLanguage("de");
  assert.deepEqual(noteTexts(["writes_refused"]), [
    "Änderungen abgelehnt: „Darf schreiben“ ist für diese Routine aus",
  ]);
  setLanguage("en");
});

test("the agent's routine list explains a refused write in the last run", async () => {
  const r = routines();
  r.list = async () => ({
    routines: [
      { id: "b", name: "Daily check", writes: false, lastFailure: null },
      { id: "c", name: "Other", writes: false, lastFailure: null },
    ],
  });
  r.results = {
    latest: (bindingId) =>
      bindingId === "b" ? { status: "ok", notes: ["writes_refused"] } : null,
  };
  const { routines: listed } = await r.listForAgent("agent", null);
  assert.equal(listed[0].lastRunWarnings.length, 1);
  assert.match(listed[0].lastRunWarnings[0], /'May write' is off for this routine/);
  assert.match(listed[0].lastRunWarnings[0], /owner/);
  assert.equal(listed[1].lastRunWarnings, undefined);
});

// The routine tool's own turn in the owner's chat, with create and update stubbed.
function toolTurn(writes) {
  const r = Object.create(NativeRoutines.prototype);
  r.assistants = {
    ledger: {
      getAttempt: () => ({ requestId: "req" }),
      getRequest: () => ({ id: "req", conversationId: "chat" }),
    },
    store: {
      getConversation: () => ({ id: "chat", assistantId: "agent" }),
      getAssistant: () => ({ id: "agent" }),
    },
    teams: { store: { context: () => ({ kind: "owner" }) } },
  };
  r.agent = () => ({});
  r.bindings = { get: () => ({ assistantId: "agent" }) };
  const routine = { id: "b", writes, prompt: "Update the plan." };
  r.createOwn = async () => routine;
  r.update = async () => routine;
  const inv = { attemptId: "a", toolCallId: "t", assertCurrent: () => {} };
  return (input) => r.invoke(inv, input);
}

test("a routine created without May write tells the agent to ask the owner", async () => {
  const created = await toolTurn(false)({ action: "create", name: "Plan", prompt: "x" });
  assert.equal(
    created.note,
    "This routine can only read project folders. If it should change files, ask the owner to switch on 'May write' for it (agent settings, Automation, Routines).",
  );
  // With "May write", and on every update, nothing is added.
  const writable = await toolTurn(true)({ action: "create", name: "Plan", prompt: "x" });
  assert.equal(writable.note, undefined);
  const updated = await toolTurn(false)({ action: "update", id: "b", revision: 1 });
  assert.equal(updated.note, undefined);
});

test("the latest recorded run of a routine is found by its binding", () => {
  const results = new RoutineResults(new DatabaseSync(":memory:"));
  const entry = (id, bindingId, notes) => ({
    id,
    conversationId: "chat",
    bindingId,
    status: "ok",
    ...(notes ? { notes } : {}),
  });
  results.record(entry("j:1", "b", ["writes_refused"]));
  results.record(entry("j:2", "c"));
  assert.deepEqual(results.latest("b").notes, ["writes_refused"]);
  results.record(entry("j:3", "b"));
  assert.equal(results.latest("b").notes, undefined);
  assert.equal(results.latest("missing"), null);
});
