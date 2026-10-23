import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  sshHistoryText,
  sshOutcome,
  sshRunView,
} from "../../web/features/assistants/ssh-run-note.js";

const note = (extra = {}) => ({
  hostName: "opnsense",
  commandPreview: "uptime",
  command: "uptime",
  outcome: "done",
  exitCode: 0,
  durationMs: 1200,
  ...extra,
});

test("a finished run reads as host, command and a done chip with its facts", () => {
  setLanguage("en");
  assert.deepEqual(sshRunView(note()), {
    label: "SSH on opnsense",
    preview: "uptime",
    command: "uptime",
    copyText: "uptime",
    partial: null,
    tone: "ok",
    status: "Done",
    exitCode: 0,
    duration: "1.2 s",
    result: null,
  });
});

test("each outcome has its chip, tone and result line", () => {
  setLanguage("en");
  const view = (extra) => sshRunView(note(extra));
  assert.deepEqual(
    [view({ outcome: "exit", exitCode: 1 }).status, view({ outcome: "exit" }).tone],
    ["Exit 1", "error"],
  );
  assert.equal(view({ outcome: "exit", exitCode: undefined }).status, "Exit ?");
  assert.deepEqual(
    [view({ outcome: "timedOut" }).status, view({ outcome: "timedOut" }).result],
    ["Timed out", "The command reached its time limit and was stopped."],
  );
  assert.deepEqual(
    [view({ outcome: "truncated" }).status, view({ outcome: "truncated" }).tone],
    ["Output truncated", "neutral"],
  );
  assert.equal(view({ outcome: "revoked" }).status, "Stopped");
  assert.equal(view({ outcome: "surprise", exitCode: 3 }).status, "Exit 3");
  assert.equal(view({ durationMs: null }).duration, null);
  // A done note from before notes carried exit codes still reads exit code 0.
  assert.equal(view({ exitCode: undefined }).exitCode, 0);
});

test("the row shows the preview while the body has the full command", () => {
  setLanguage("en");
  const command = `python3 -c 'import pathlib,shutil'\n${"x".repeat(200)}`;
  const view = sshRunView(note({ commandPreview: "python3 -c 'import…", command }));
  assert.equal(view.preview, "python3 -c 'import…");
  assert.equal(view.command, command);
  assert.equal(sshRunView(note({ command, commandCut: true })).partial, "cut");
  const old = sshRunView(note({ command: undefined, commandPreview: "tail -f …" }));
  assert.deepEqual([old.command, old.partial], ["tail -f …", "preview"]);
});

test("a copy holds hidden characters as the codes the owner sees", () => {
  setLanguage("en");
  const view = sshRunView(note({ command: "ls‮ -la", commandPreview: "ls‮ -la" }));
  assert.equal(view.copyText, "ls[U+202E] -la");
  assert.equal(view.command, "ls‮ -la");
});

test("history rows and outcomes read as before, also in German", () => {
  setLanguage("en");
  assert.equal(sshOutcome({ exitCode: 0 }), "done");
  assert.equal(sshOutcome({ exitCode: 0, truncated: true }), "truncated");
  assert.equal(sshOutcome({ reason: "revoked" }), "revoked");
  assert.equal(
    sshHistoryText({
      state: "completed",
      payload: { hostName: "opnsense" },
      result: { exitCode: 0, durationMs: 1200 },
    }),
    "SSH on opnsense · done · 1.2 s",
  );
  assert.equal(
    sshHistoryText({ state: "declined", payload: { hostName: "opnsense" } }),
    "SSH on opnsense · Denied",
  );
  setLanguage("de");
  const de = sshRunView(note({ outcome: "exit", exitCode: 2 }));
  assert.deepEqual([de.label, de.status], ["SSH auf opnsense", "Exit 2"]);
  assert.equal(sshRunView(note()).status, "Fertig");
  setLanguage("en");
});
