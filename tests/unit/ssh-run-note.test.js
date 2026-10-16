import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  sshHistoryText,
  sshOutcome,
  sshRunNoteText,
} from "../../web/features/assistants/ssh-run-note.js";

test("run notes and history rows read as the spec says", () => {
  setLanguage("en");
  assert.equal(
    sshRunNoteText({ hostName: "opnsense", commandPreview: "uptime", outcome: "done" }),
    "SSH on opnsense: uptime · done",
  );
  assert.equal(
    sshRunNoteText({
      hostName: "nas-01",
      commandPreview: "systemctl restart smb",
      outcome: "exit",
      exitCode: 1,
    }),
    "SSH on nas-01: systemctl restart smb · exit 1",
  );
  assert.equal(
    sshRunNoteText({
      hostName: "nas-01",
      commandPreview: "tail -f …",
      outcome: "timedOut",
    }),
    "SSH on nas-01: tail -f … · timed out",
  );
  assert.equal(
    sshRunNoteText({ hostName: "h", commandPreview: "ls‮", outcome: "done" }),
    "SSH on h: ls[U+202E] · done",
  );
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
  assert.equal(
    sshRunNoteText({ hostName: "opnsense", commandPreview: "uptime", outcome: "done" }),
    "SSH auf opnsense: uptime · fertig",
  );
});
