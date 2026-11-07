import test from "node:test";
import assert from "node:assert/strict";
import {
  cardSummary,
  entryDetail,
  listTime,
  neighbours,
  pinboardSections,
} from "../../web/features/assistants/pinboard/pinboard-view.js";
import { pinboardFileUrl } from "../../web/features/assistants/pinboard/pinboard-api.js";
import { agentPinboardCopy as en } from "../../web/lib/i18n/en/agent-pinboard.js";
import { agentPinboardCopy as de } from "../../web/lib/i18n/de/agent-pinboard.js";
import { formatBytes } from "../../web/lib/format-bytes.js";

const entry = (id, extra = {}) => ({
  id,
  name: `${id}.md`,
  note: "",
  kind: "text",
  size: 0,
  state: "ok",
  fresh: false,
  ...extra,
});
const list = (id, extra = {}) => ({
  id,
  title: id,
  description: "",
  origin: null,
  archived: false,
  updatedAt: "2026-11-07T10:00:00.000Z",
  entries: [],
  ...extra,
});

test("pinboardSections keeps the server's newest-first order and puts archived last", () => {
  const view = {
    lists: [list("new"), list("done", { archived: true }), list("older")],
    fresh: 0,
  };
  const { open, archived } = pinboardSections(view);
  assert.deepEqual(
    open.map((item) => item.id),
    ["new", "older"],
  );
  assert.deepEqual(
    archived.map((item) => item.id),
    ["done"],
  );
});

test("pinboardSections of no view is empty", () => {
  assert.deepEqual(pinboardSections(null), { open: [], archived: [] });
});

test("neighbours skip unavailable entries and count only readable ones", () => {
  const board = list("l", {
    entries: [
      entry("a"),
      entry("gone", { state: "unavailable" }),
      entry("b"),
      entry("c"),
    ],
  });
  const middle = neighbours(board, "b");
  assert.equal(middle.entry.id, "b");
  assert.equal(middle.previous.id, "a");
  assert.equal(middle.next.id, "c");
  assert.equal(middle.index, 1);
  assert.equal(middle.total, 3);
  assert.deepEqual(
    { previous: neighbours(board, "a").previous, next: neighbours(board, "c").next },
    { previous: null, next: null },
  );
  assert.deepEqual(neighbours(board, "missing"), {
    entry: null,
    previous: null,
    next: null,
    index: -1,
    total: 3,
  });
});

test("neighbours keep the entry being read when it turns unavailable", () => {
  const board = list("l", {
    entries: [entry("a"), entry("b", { state: "unavailable" }), entry("c")],
  });
  const reading = neighbours(board, "b");
  assert.equal(reading.entry.id, "b");
  assert.equal(reading.previous.id, "a");
  assert.equal(reading.next.id, "c");
  assert.deepEqual([reading.index, reading.total], [1, 3]);
  // Read from elsewhere, it is skipped.
  assert.equal(neighbours(board, "a").next.id, "c");
});

test("pinboardFileUrl names the entry, its version and a download", () => {
  assert.equal(
    pinboardFileUrl("a b", "e/1"),
    "/api/assistants/a%20b/pinboard/entries/e%2F1/file",
  );
  assert.equal(
    pinboardFileUrl("a", "e", { version: 2 }),
    "/api/assistants/a/pinboard/entries/e/file?v=2",
  );
  assert.equal(
    pinboardFileUrl("a", "e", { download: true }),
    "/api/assistants/a/pinboard/entries/e/file?download=1",
  );
});

test("entryDetail joins note, duration and size with ' · ' and drops what is missing", () => {
  assert.equal(
    entryDetail(entry("a", { note: "shortened", size: 2048 }), en),
    `shortened · ${formatBytes(2048)}`,
  );
  assert.equal(
    entryDetail(entry("v", { kind: "video", duration: 161, size: 4096 }), en),
    `2:41 · ${formatBytes(4096)}`,
  );
  assert.equal(entryDetail(entry("e"), en), "");
});

test("entryDetail of an unavailable entry says it is no longer available", () => {
  assert.equal(
    entryDetail(entry("a", { note: "x", size: 10, state: "unavailable" }), en),
    "No longer available",
  );
  assert.equal(
    entryDetail(entry("a", { state: "unavailable" }), de),
    "Nicht mehr verfügbar",
  );
});

test("listTime is a relative time in the given locale", () => {
  const now = Date.parse("2026-11-07T10:04:00.000Z");
  assert.equal(listTime("2026-11-07T10:00:00.000Z", now, "en-US"), "4 minutes ago");
  assert.equal(listTime("2026-11-07T10:04:00.000Z", now, "en-US"), "now");
  assert.equal(listTime("2026-11-06T10:00:00.000Z", now, "en-US"), "yesterday");
  assert.equal(listTime("not a date", now, "en-US"), "");
});

test("cardSummary names the counts, then up to three files", () => {
  assert.equal(
    cardSummary({ added: 1, updated: 2, names: ["Episode 6", "Rough cut"] }, en),
    "2 files updated, 1 added · Episode 6, Rough cut",
  );
  assert.equal(
    cardSummary({ added: 0, updated: 0, removed: 4, names: ["a", "b", "c", "d"] }, en),
    "4 removed · a, b, c",
  );
  assert.equal(
    cardSummary({ added: 2, updated: 1, removed: 0 }, en),
    "1 file updated, 2 added",
  );
  assert.equal(cardSummary({ names: ["only"] }, en), "only");
  assert.equal(
    cardSummary({ updated: 1, added: 1, names: ["Folge 6"] }, de),
    "1 Datei aktualisiert, 1 hinzugefügt · Folge 6",
  );
});
