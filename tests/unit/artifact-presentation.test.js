import test from "node:test";
import assert from "node:assert/strict";
import * as de from "../../web/lib/i18n/de/artifacts.js";
import * as en from "../../web/lib/i18n/en/artifacts.js";
import {
  artifactDateGroup,
  artifactKind,
  artifactListQuery,
  artifactSourceLine,
  artifactTypeLabel,
  groupArtifactsByDate,
  relativeTime,
  shortId,
  storageWarning,
} from "../../web/features/artifacts/artifact-presentation.js";
import { formatBytes } from "../../web/lib/format-bytes.js";

const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute);

test("type labels name web pages and image formats instead of MIME types", () => {
  assert.equal(artifactKind("text/html"), "page");
  assert.equal(artifactKind("image/svg+xml"), "image");
  assert.equal(artifactKind("application/json"), "file");
  assert.equal(artifactKind(undefined), "file");
  const labels = (types) =>
    ["text/html", "image/png", "image/svg+xml", "image/x-new", "font/woff2"].map((type) =>
      artifactTypeLabel(type, types),
    );
  assert.deepEqual(labels(en.artifactCopy.types), [
    "Web page",
    "Image · PNG",
    "Image · SVG",
    "Image · X-NEW",
    "File",
  ]);
  assert.deepEqual(labels(de.artifactCopy.types), [
    "Webseite",
    "Bild · PNG",
    "Bild · SVG",
    "Bild · X-NEW",
    "Datei",
  ]);
});

test("date groups follow local calendar days around midnight", () => {
  const now = at(13, 0, 5);
  assert.equal(artifactDateGroup(at(13, 0, 1), now), "today");
  assert.equal(artifactDateGroup(at(12, 23, 59), now), "yesterday");
  assert.equal(artifactDateGroup(at(12, 0, 0), now), "yesterday");
  assert.equal(artifactDateGroup(at(11, 23, 59), now), "week");
  assert.equal(artifactDateGroup(at(7, 0, 0), now), "week");
  assert.equal(artifactDateGroup(at(6, 23, 59), now), "earlier");
  // Clock skew between server and browser never moves an entry into the past.
  assert.equal(artifactDateGroup(at(13, 9), now), "today");
  assert.equal(artifactDateGroup("not a date", now), "earlier");
  const items = [at(13, 0, 1), at(12, 18), at(12, 9), at(10, 9), at(1, 9)].map(
    (date, index) => ({ id: String(index), updatedAt: date.toISOString() }),
  );
  assert.deepEqual(
    groupArtifactsByDate(items, now).map(({ group, items: rows }) => [
      group,
      rows.map((row) => row.id),
    ]),
    [
      ["today", ["0"]],
      ["yesterday", ["1", "2"]],
      ["week", ["3"]],
      ["earlier", ["4"]],
    ],
  );
  assert.deepEqual(groupArtifactsByDate([], now), []);
});

test("date groups count a daylight saving day as one day", () => {
  const previous = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try {
    // 25 October 2026 has 25 hours in Berlin.
    const now = new Date(2026, 9, 26, 0, 30);
    assert.equal(artifactDateGroup(new Date(2026, 9, 25, 0, 10), now), "yesterday");
    assert.equal(artifactDateGroup(new Date(2026, 9, 24, 23, 50), now), "week");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("relative times read naturally in English and German", () => {
  const now = at(13, 12);
  const english = (date) =>
    relativeTime(date, { now, locale: "en-US", justNow: en.artifactCopy.justNow });
  const german = (date) =>
    relativeTime(date, { now, locale: "de-DE", justNow: de.artifactCopy.justNow });
  assert.equal(english(new Date(now.getTime() - 30000)), "just now");
  assert.equal(english(at(13, 11, 42)), "18 minutes ago");
  assert.equal(english(at(13, 9)), "3 hours ago");
  assert.equal(english(at(12, 9)), "yesterday");
  assert.equal(english(at(10, 20)), "3 days ago");
  assert.equal(english(new Date(2026, 7, 1)), "2 months ago");
  assert.equal(german(at(13, 11, 42)), "vor 18 Minuten");
  assert.equal(german(at(12, 9)), "gestern");
  assert.equal(german(at(11, 9)), "vorgestern");
  assert.equal(english("invalid"), "");
});

test("source lines name the session and project or say the session was deleted", () => {
  const lists = {
    sessions: [{ id: "s1", name: "Settings QA" }, { id: "s2" }],
    projects: [{ id: "p1", name: "agent-pier" }],
  };
  const line = (item, copy = en.artifactCopy) => artifactSourceLine(item, lists, copy);
  assert.equal(line({ sessionId: "s1", projectId: "p1" }), "Settings QA · agent-pier");
  assert.equal(
    line({ sessionId: "s1", projectId: "p1", orphaned: true }),
    "Session deleted · agent-pier",
  );
  assert.equal(
    line({ sessionId: "gone", projectId: "p1", orphaned: true }, de.artifactCopy),
    "Session gelöscht · agent-pier",
  );
  assert.equal(
    line({ sessionId: "s2", projectId: "p1" }),
    "Unnamed session · agent-pier",
  );
  assert.equal(line({ sessionId: "unknown", projectId: "unknown" }), "");
  assert.equal(artifactSourceLine({ sessionId: "s1" }, {}, en.artifactCopy), "");
});

test("list queries carry only active filters", () => {
  assert.equal(artifactListQuery({ page: 1 }), "page=1");
  assert.equal(
    artifactListQuery({ projectId: "p1", page: 2, q: "  audit ", pinned: true }),
    "page=2&projectId=p1&q=audit&pinned=true",
  );
  assert.equal(artifactListQuery({ q: "Settings\tQA\n" }), "page=1&q=Settings+QA");
  assert.equal(
    artifactListQuery({ sessionId: "s1", q: "   ", pinned: false }),
    "page=1&sessionId=s1",
  );
  assert.equal(
    new URLSearchParams(artifactListQuery({ q: "x".repeat(300) })).get("q").length,
    200,
  );
});

test("sizes, storage warning and short IDs", () => {
  assert.equal(formatBytes(9.2 * 1024 ** 2, "en-US"), "9.2 MB");
  assert.equal(formatBytes(1024 ** 3, "en-US"), "1 GB");
  assert.equal(formatBytes(1536, "de-DE"), "1,5 kB");
  assert.equal(formatBytes(42, "en-US"), "42 byte");
  assert.equal(storageWarning({ usedBytes: 81, limitBytes: 100 }), true);
  assert.equal(storageWarning({ usedBytes: 80, limitBytes: 100 }), false);
  assert.equal(storageWarning(undefined), false);
  assert.equal(shortId("3f2a9c1e-0000-4000-8000-00000000b6c5"), "3f2a9c1e…b6c5");
  assert.equal(shortId("example"), "example");
});
