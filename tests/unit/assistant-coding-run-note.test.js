import test from "node:test";
import assert from "node:assert/strict";
import { codingRunNoteText } from "../../web/features/assistants/coding-run-note.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

const note = (values) => ({
  role: "event",
  event: "coding-run",
  phase: "result",
  state: "completed",
  runId: "run",
  pipelineName: "Build",
  projectName: "App",
  ...values,
});

test("coding run notes read as translated sentences in English and German", (t) => {
  t.after(() => setLanguage("en"));
  setLanguage("en");
  assert.equal(
    codingRunNoteText(note({ phase: "started", state: "running" })),
    "Coding run started: Build · App",
  );
  assert.equal(codingRunNoteText(note()), "Coding run completed: Build · App");
  assert.equal(
    codingRunNoteText(note({ state: "failed", memberName: "Ada" })),
    "Coding run requested by Ada failed: Build · App",
  );
  setLanguage("de");
  assert.equal(codingRunNoteText(note()), "Coding-Lauf abgeschlossen: Build · App");
  assert.equal(
    codingRunNoteText(note({ state: "cancelled" })),
    "Coding-Lauf abgebrochen: Build · App",
  );
  assert.equal(
    codingRunNoteText(note({ phase: "started", state: "running", memberName: "Ada" })),
    "Coding-Lauf von Ada gestartet: Build · App",
  );
});
