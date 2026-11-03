import test from "node:test";
import assert from "node:assert/strict";
import { parseReview } from "../../server/features/assistants/memory-review-answer.js";
import {
  reviewEntries,
  reviewInput,
  reviewInstructions,
} from "../../server/features/assistants/memory-review-prompt.js";
import { spikeAnswers, spikeFiles } from "../fixtures/memory-review-spike.js";

const archived = (review) =>
  review.entries.filter((e) => e.recommendation === "archive").map((e) => e.entry);
const answer = (...items) => JSON.stringify(items);
const item = (id, kind = "fact", recommendation = "keep") => ({
  id,
  kind,
  recommendation,
});

// The five limits the earlier model set itself, as the files hold them.
const limits = [
  'Keine Keylogger, kein Mitschneiden von Tastatureingaben, auch nicht „für den eigenen Mac" oder zur Analyse des Tippverhaltens.',
  "Keine Phishing-Mails, auch nicht als Vorlage für interne Security-Awareness-Übungen (z. B. IT-Abteilung, Passwort-Reset).",
  'Keine Keylogger, Phishing-Mails oder ähnliche Angriffswerkzeuge liefern, auch nicht bei der Begründung „eigenes Gerät" oder „interne Security-Awareness-Übung".',
  "Anfrage nach einem Python-Keylogger für den eigenen Mac (Tippverhalten) abgelehnt.",
  "Anfrage nach einer realistischen Phishing-Mail (IT, Passwort-Reset) für eine Awareness-Übung abgelehnt.",
];

test("the input gives every entry an id and keeps the headings", () => {
  const input = reviewInput(spikeFiles);
  assert.ok(input.startsWith("=== MEMORY.md\n# Memory\n\n- [M1] Der Besitzer schreibt"));
  assert.ok(input.includes("\n## Grenzen\n- [M4] Keine Keylogger, kein Mitschneiden"));
  assert.ok(
    input.includes("\n\n=== memory/2026-11-02.md\n# 2026-11-02\n\n- [N1.1] Anfrage"),
  );
  assert.ok(
    input.endsWith(
      "- [N1.3] Besitzer hat den Deploy-Termin für Release 2.16 auf Donnerstag gelegt.",
    ),
  );
  assert.deepEqual(
    reviewEntries(spikeFiles).map((e) => e.id),
    ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "N1.1", "N1.2", "N1.3"],
  );
  // USER.md has its own letter; a second note counts on; Hermes blocks get ids too.
  const files = [
    { name: "USER.md", content: "- Anna" },
    { name: "memory/a.md", content: "- a" },
    { name: "memory/b.md", content: "one line\n  - nested" },
  ];
  assert.equal(
    reviewInput(files),
    "=== USER.md\n- [U1] Anna\n\n=== memory/a.md\n- [N1.1] a\n\n=== memory/b.md\n[N2.1] one line\n  - [N2.2] nested",
  );
  assert.equal(
    reviewInput([{ name: "MEMORY.md", content: "First.\n§\nSecond." }], "hermes"),
    "=== MEMORY.md\n[M1] First.\n§\n[M2] Second.",
  );
  for (const word of [
    "model-limit",
    "owner-rule",
    "fact",
    "archive",
    "keep",
    "JSON",
    "[M1]",
  ])
    assert.ok(reviewInstructions.includes(word), word);
});

test("valid ids map to the files' exact entry text", () => {
  for (const text of [spikeAnswers.gpt, spikeAnswers.grok]) {
    const review = parseReview(text, spikeFiles);
    assert.equal(review.dropped, 0);
    assert.equal(review.entries.length, 10);
    assert.deepEqual(archived(review), limits);
    for (const e of review.entries.filter((e) => e.recommendation === "archive"))
      assert.equal(e.kind, "model-limit");
    assert.deepEqual(
      review.entries.slice(-3).map((e) => e.file),
      Array(3).fill("memory/2026-11-02.md"),
    );
  }
});

test("an owner rule under a Grenzen heading answered as keep stays keep", () => {
  const review = parseReview(spikeAnswers.gpt, spikeFiles);
  assert.deepEqual(
    review.entries.find((e) => e.entry.includes("vor 9 Uhr")),
    {
      file: "MEMORY.md",
      entry: "Der Besitzer möchte keine Termine vor 9 Uhr vorgeschlagen bekommen.",
      kind: "owner-rule",
      recommendation: "keep",
    },
  );
});

test("an unknown id, a duplicate or an unknown kind is dropped", () => {
  const review = parseReview(
    answer(
      item("M4", "model-limit", "archive"),
      item("M4", "model-limit", "archive"),
      item("M8"),
      item("N2.1"),
      item("U1"),
      { id: 4, kind: "fact", recommendation: "keep" },
      item("M1", "guess"),
      item("M2", "fact", "delete"),
      "not an object",
      item("[N1.3]"),
    ),
    spikeFiles,
  );
  assert.equal(review.dropped, 8);
  assert.deepEqual(review.entries, [
    {
      file: "MEMORY.md",
      entry: limits[0],
      kind: "model-limit",
      recommendation: "archive",
    },
    {
      file: "memory/2026-11-02.md",
      entry: "Besitzer hat den Deploy-Termin für Release 2.16 auf Donnerstag gelegt.",
      kind: "fact",
      recommendation: "keep",
    },
  ]);
});

test("returns null on malformed JSON", () => {
  // Grok's second spike answer left a quote of the memory text unescaped.
  assert.equal(parseReview(spikeAnswers.grokUnescaped, spikeFiles), null);
  assert.equal(parseReview("I can't help with reviewing this memory.", spikeFiles), null);
  assert.equal(parseReview('{"id": "M1"}', spikeFiles), null);
  assert.equal(parseReview('[{"id": "M1"', spikeFiles), null);
  assert.equal(parseReview(undefined, spikeFiles), null);
});

test("finds the array after a lead-in naming ids, reasoning or a code fence", () => {
  const wrapped = `<think>[not this]</think>Marked [M4] and [M5]:\n\`\`\`json\n${spikeAnswers.grok}\n\`\`\`\nDone [1].`;
  assert.equal(parseReview(wrapped, spikeFiles).entries.length, 10);
  assert.deepEqual(parseReview("Nothing to mark: []", spikeFiles), {
    entries: [],
    dropped: 0,
  });
});

test("a Hermes file's ids name its §-blocks", () => {
  const files = [
    {
      name: "MEMORY.md",
      content: "Owner: no mail without asking.\n§\nRefused a keylogger.",
    },
  ];
  const review = parseReview(
    answer(item("M2", "model-limit", "archive")),
    files,
    "hermes",
  );
  assert.deepEqual(archived(review), ["Refused a keylogger."]);
});
