// The Dream diary as the memory pages show it (web/features/assistants/settings/
// dream-diary.js): a Hermes agent's structured entries in the reader's language, an
// OpenClaw agent's DREAMS.md as it is.
import test from "node:test";
import assert from "node:assert/strict";
import { diaryText } from "../../web/features/assistants/settings/dream-diary.js";
import { assistantDreamingCopy as en } from "../../web/lib/i18n/en/assistant-dreaming.js";
import { assistantDreamingCopy as de } from "../../web/lib/i18n/de/assistant-dreaming.js";

const counts = (added, merged, replaced, dropped) => ({
  kept: 3,
  added,
  merged,
  replaced,
  dropped,
});
const entries = [
  {
    at: "2026-11-08T03:05:00.000Z",
    night: "2026-11-08",
    outcome: "applied",
    reason: null,
    file: null,
    counts: { "MEMORY.md": counts(2, 1, 0, 1), "USER.md": counts(0, 0, 1, 0) },
    chars: { "MEMORY.md": 812, "USER.md": 140 },
    summary: "Merged the tea notes.",
  },
  {
    at: "2026-11-07T03:05:00.000Z",
    night: "2026-11-07",
    outcome: "discarded",
    reason: "pinLost",
    file: "USER.md",
    counts: { "MEMORY.md": counts(0, 0, 0, 0), "USER.md": counts(0, 0, 0, 1) },
    chars: { "MEMORY.md": 800, "USER.md": 120 },
    summary: "Dropped the vault path.",
  },
  {
    at: "2026-11-06T03:05:00.000Z",
    night: "2026-11-06",
    outcome: "postponed",
    reason: "changed",
    file: "MEMORY.md",
    counts: null,
    chars: null,
    summary: "",
  },
  {
    at: "2026-11-05T03:05:00.000Z",
    night: "2026-11-05",
    outcome: "failed",
    reason: "unavailable",
    file: null,
    counts: null,
    chars: null,
    summary: "",
  },
];

test("entries render newest first in English", () => {
  const text = diaryText({ name: "DREAMS.md", content: "", entries }, en);
  const blocks = text.split("\n\n");
  assert.deepEqual(
    blocks.map((block) => block.split("\n")[0]),
    ["2026-11-08", "2026-11-07", "2026-11-06", "2026-11-05"],
  );
  assert.equal(
    blocks[0],
    [
      "2026-11-08",
      en.nightApplied,
      en.nightCounts("MEMORY.md", { added: 2, merged: 1, replaced: 0, dropped: 1 }),
      en.nightCounts("USER.md", { added: 0, merged: 0, replaced: 1, dropped: 0 }),
      "Merged the tea notes.",
    ].join("\n"),
  );
  assert.match(blocks[0], /MEMORY\.md: 2 added, 1 merged, 0 replaced, 1 dropped/);
  assert.equal(blocks[1].split("\n")[1], en.nightDiscarded.pinLost("USER.md"));
  assert.match(blocks[1], /USER\.md/);
  // A discarded night changed nothing: neither counts nor summary read as if applied.
  assert.equal(
    blocks[1],
    ["2026-11-07", en.nightDiscarded.pinLost("USER.md")].join("\n"),
  );
  assert.equal(blocks[2].split("\n")[1], en.nightPostponed("MEMORY.md"));
  assert.equal(blocks[3].split("\n")[1], en.nightFailed);
  // The same entries in German use the German catalog.
  const german = diaryText({ entries }, de);
  assert.match(german, new RegExp(de.nightDiscarded.pinLost("USER.md")));
});

test("OpenClaw content passes through", () => {
  const content = "# Dream Diary\n\nA calm night of sorting notes.";
  assert.equal(diaryText({ name: "DREAMS.md", content }, en), content);
  assert.equal(
    diaryText({ name: "MEMORY.md", content: "Owner likes tea" }, en),
    "Owner likes tea",
  );
  assert.equal(diaryText({ name: "USER.md", missing: true }, en), "");
  assert.equal(diaryText(null, en), "");
});
