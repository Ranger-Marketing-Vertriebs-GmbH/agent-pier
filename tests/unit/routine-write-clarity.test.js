import test from "node:test";
import assert from "node:assert/strict";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { DatabaseSync } from "node:sqlite";
import {
  RoutineResults,
  withRoutineResults,
} from "../../server/features/assistants/routine-results.js";
import { routineWriteHint } from "../../server/features/assistants/routine-write-hint.js";
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

test("a routine whose task suggests writing tells the agent to ask for May write", () => {
  const hinted = routineWriteHint({
    id: "b",
    writes: false,
    prompt: "Prüfe den Vorrat und dokumentiere das Ergebnis im Plan.",
  });
  assert.match(hinted.note, /ask the owner to switch on 'May write'/);
  for (const routine of [
    { id: "b", writes: true, prompt: "Update the plan file." },
    { id: "b", writes: false, prompt: "Summarize the news." },
  ])
    assert.equal(routineWriteHint(routine).note, undefined);
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
