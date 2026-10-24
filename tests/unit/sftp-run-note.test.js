import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  sftpHistoryText,
  sftpProgressText,
  sftpRunView,
} from "../../web/features/assistants/sftp-run-note.js";

const note = (extra = {}) => ({
  id: "sftp-run:j1",
  event: "sftp-run",
  hostName: "nas-01",
  operation: "upload",
  direction: "up",
  remotePath: "/srv/www",
  toPath: null,
  localPath: "dist",
  localProject: "Site",
  state: "completed",
  progress: null,
  result: {
    state: "completed",
    files: 124,
    bytes: 3.5 * 1024 ** 2,
    created: 120,
    updated: 4,
    deleted: 0,
    overwrites: 4,
    durationMs: 3400,
  },
  ...extra,
});
const running = (progress) => note({ state: "executing", result: null, progress });

test("a finished upload reads as host, path and a done chip with counts and bytes", () => {
  setLanguage("en");
  assert.deepEqual(sftpRunView(note(), "en-US"), {
    icon: "upload",
    label: "Upload to nas-01",
    detail: "/srv/www",
    status: "Done",
    tone: "ok",
    facts: [
      ["Path on the server", "/srv/www"],
      ["Local path", "Site · dist"],
      ["Files", "120 new · 4 changed · 0 deleted"],
      ["Size", "3.5 MB"],
      ["Overwritten", "4"],
      ["Duration", "3.4 s"],
    ],
  });
});

test("the same row in German", () => {
  setLanguage("de");
  const view = sftpRunView(note(), "de-DE");
  assert.equal(view.label, "Hochladen auf nas-01");
  assert.equal(view.status, "Fertig");
  assert.deepEqual(view.facts[2], ["Dateien", "120 neu · 4 geändert · 0 gelöscht"]);
  assert.deepEqual(view.facts[3], ["Größe", "3,5 MB"]);
  assert.equal(
    sftpProgressText({ files: 124, filesDone: 12, bytes: 100, bytesDone: 42 }),
    "42 % · 12 von 124 Dateien",
  );
  setLanguage("en");
});

test("a running transfer shows its progress in the chip and its facts", () => {
  setLanguage("en");
  const view = sftpRunView(
    running({ files: 124, filesDone: 12, bytes: 1000, bytesDone: 425, current: "a.css" }),
    "en-US",
  );
  assert.equal(view.status, "42 % · 12 of 124 files");
  assert.equal(view.tone, "running");
  assert.deepEqual(view.facts.slice(-2), [
    ["Progress", "42 % · 12 of 124 files"],
    ["Current file", "a.css"],
  ]);
  // Without bytes (a delete) the files count; with nothing planned it just runs.
  assert.equal(sftpProgressText({ files: 4, filesDone: 1 }), "25 % · 1 of 4 files");
  assert.equal(sftpRunView(running({ files: 0 }), "en-US").status, "Running");
  assert.equal(sftpRunView(running(null), "en-US").status, "Running");
});

test("tones and icons follow the state and the operation", () => {
  setLanguage("en");
  const view = (extra) => sftpRunView(note(extra), "en-US");
  assert.deepEqual(
    ["completed", "failed", "cancelled", "unknown"].map((state) => [
      view({ state }).status,
      view({ state }).tone,
    ]),
    [
      ["Done", "ok"],
      ["Failed", "error"],
      ["Stopped", "neutral"],
      ["Unknown", "error"],
    ],
  );
  assert.deepEqual(
    [
      { operation: "download", direction: "down" },
      { operation: "sync", direction: "up" },
      { operation: "sync", direction: "down" },
      { operation: "mkdir" },
      { operation: "rename", toPath: "/srv/new" },
      { operation: "delete" },
    ].map((extra) => [view(extra).icon, view(extra).label, view(extra).detail]),
    [
      ["download", "Download from nas-01", "/srv/www"],
      ["upload", "Sync to nas-01", "/srv/www"],
      ["download", "Sync from nas-01", "/srv/www"],
      ["folder", "New folder on nas-01", "/srv/www"],
      ["folder", "Rename on nas-01", "/srv/www → /srv/new"],
      ["trash", "Delete on nas-01", "/srv/www"],
    ],
  );
});

test("a failed run names its code and the path it stopped at", () => {
  setLanguage("en");
  const view = sftpRunView(
    note({
      state: "failed",
      result: {
        state: "failed",
        files: 3,
        bytes: 10,
        created: 3,
        updated: 0,
        deleted: 0,
        code: "SFTP_PERMISSION_DENIED",
        failedPath: "/srv/www/x",
        durationMs: 800,
      },
    }),
    "en-US",
  );
  assert.equal(view.status, "Failed");
  assert.deepEqual(view.facts.slice(-3), [
    ["Duration", "0.8 s"],
    ["Error", "SFTP_PERMISSION_DENIED"],
    ["Failed at", "/srv/www/x"],
  ]);
});

test("a delete counts files and folders, a mkdir no files", () => {
  setLanguage("en");
  const del = sftpRunView(
    note({
      operation: "delete",
      localPath: null,
      result: { state: "completed", files: 3, dirs: 1, durationMs: 100 },
    }),
    "en-US",
  );
  assert.deepEqual(del.facts, [
    ["Path on the server", "/srv/www"],
    ["Files", "3 files · 1 folder"],
    ["Duration", "0.1 s"],
  ]);
  const mkdir = sftpRunView(
    note({ operation: "mkdir", localPath: null, result: { state: "completed" } }),
    "en-US",
  );
  assert.deepEqual(mkdir.facts, [["Path on the server", "/srv/www"]]);
});

test("one Work tab history line per SFTP row", () => {
  setLanguage("en");
  const action = (extra) => ({
    state: "completed",
    payload: { action: "sftp", hostName: "nas-01", operation: "upload", direction: "up" },
    result: { state: "completed", files: 124, bytes: 2048, durationMs: 1200 },
    ...extra,
  });
  assert.equal(
    sftpHistoryText(action(), "en-US"),
    "SFTP · Upload on nas-01 · Done · 124 files · 2 kB · 1.2 s",
  );
  assert.equal(
    sftpHistoryText(action({ state: "declined", result: undefined }), "en-US"),
    "SFTP · Upload on nas-01 · Denied",
  );
  assert.equal(
    sftpHistoryText(
      action({ state: "failed", result: { state: "failed", code: "SFTP_TIMEOUT" } }),
      "en-US",
    ),
    "SFTP · Upload on nas-01 · Failed · SFTP_TIMEOUT",
  );
  setLanguage("de");
  assert.equal(
    sftpHistoryText(action(), "de-DE"),
    "SFTP · Hochladen auf nas-01 · Fertig · 124 Dateien · 2 kB · 1,2 s",
  );
  setLanguage("en");
});
