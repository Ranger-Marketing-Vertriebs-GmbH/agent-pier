import test from "node:test";
import assert from "node:assert/strict";
import { parseReview } from "../../server/features/assistants/memory-review-answer.js";
import {
  reviewInput,
  reviewInstructions,
} from "../../server/features/assistants/memory-review-prompt.js";
import { spikeAnswers, spikeFiles } from "../fixtures/memory-review-spike.js";

const archived = (review) =>
  review.entries.filter((e) => e.recommendation === "archive").map((e) => e.entry);

test("keeps verbatim matches", () => {
  // Grok's third answer quoted every entry whole (with typographic quotes).
  const review = parseReview(spikeAnswers.grokCurly, spikeFiles);
  assert.equal(review.dropped, 0);
  assert.equal(review.entries.length, 10);
  // The entry is the file's own text, as the archive finds it again.
  assert.deepEqual(archived(review), [
    'Keine Keylogger, kein Mitschneiden von Tastatureingaben, auch nicht „für den eigenen Mac" oder zur Analyse des Tippverhaltens.',
    "Keine Phishing-Mails, auch nicht als Vorlage für interne Security-Awareness-Übungen (z. B. IT-Abteilung, Passwort-Reset).",
    'Keine Keylogger, Phishing-Mails oder ähnliche Angriffswerkzeuge liefern, auch nicht bei der Begründung „eigenes Gerät" oder „interne Security-Awareness-Übung".',
    "Anfrage nach einem Python-Keylogger für den eigenen Mac (Tippverhalten) abgelehnt.",
    "Anfrage nach einer realistischen Phishing-Mail (IT, Passwort-Reset) für eine Awareness-Übung abgelehnt.",
  ]);
  for (const e of review.entries.filter((e) => e.recommendation === "archive"))
    assert.equal(e.kind, "model-limit");
});

test("curly quotes for straight ones, a list marker and spacing still match", () => {
  const marked = JSON.stringify([
    {
      file: "MEMORY.md",
      entry: "-   Der Besitzer schreibt auf Deutsch;  Antworten auf Deutsch.",
      kind: "owner-rule",
      recommendation: "keep",
    },
  ]);
  assert.equal(parseReview(marked, spikeFiles).entries.length, 1);
});

const quote = (entry) =>
  JSON.stringify([{ file: "MEMORY.md", entry, kind: "fact", recommendation: "keep" }]);

test("an entry's unique start of half its length at a word's end names it", () => {
  const review = parseReview(quote("Der Besitzer schreibt auf Deutsch;"), spikeFiles);
  assert.deepEqual(
    review.entries.map((e) => e.entry),
    ["Der Besitzer schreibt auf Deutsch; Antworten auf Deutsch."],
  );
  // Two limits start with these words, and two words are too few.
  assert.equal(parseReview(quote("Keine Keylogger,"), spikeFiles).dropped, 1);
  assert.equal(parseReview(quote("Vorgabe des"), spikeFiles).dropped, 1);
});

test("a start cut mid-word names no entry", () => {
  const files = [{ name: "MEMORY.md", content: "- Never send emails without asking.\n" }];
  assert.equal(parseReview(quote("Never send e"), files).dropped, 1);
  assert.equal(parseReview(quote("Never send emails without"), files).entries.length, 1);
});

test("a few words of a long owner rule name no entry", () => {
  // Three words, the only start of the rule, yet under half of it.
  assert.equal(parseReview(quote("Der Besitzer möchte"), spikeFiles).dropped, 1);
});

test("the spike's starts under half an entry are dropped", () => {
  // GPT 2 quoted two limits by 44 % and 45 % of their text; Grok 3 quoted all whole.
  const whole = parseReview(spikeAnswers.gptWhole, spikeFiles);
  assert.equal(whole.dropped, 2);
  assert.equal(archived(whole).length, 3);
  // GPT 1 quoted starts only: four limits (44, 36, 45, 45 %) and an owner rule
  // (34 %) fall under half; one limit (67 %) and four other entries stay.
  const starts = parseReview(spikeAnswers.gptStarts, spikeFiles);
  assert.equal(starts.dropped, 5);
  assert.deepEqual(archived(starts), [
    "Anfrage nach einem Python-Keylogger für den eigenen Mac (Tippverhalten) abgelehnt.",
  ]);
  // Each kept entry is the file's whole entry.
  assert.ok(starts.entries[0].entry.endsWith("; Antworten auf Deutsch."));
});

test("drops an entry that is not in the file", () => {
  const answer = JSON.stringify([
    // In another file than the one named.
    {
      file: "MEMORY.md",
      entry: "Besitzer hat den Deploy-Termin für Release 2.16 auf Donnerstag gelegt.",
      kind: "fact",
      recommendation: "keep",
    },
    // A file the review never showed.
    { file: "SOUL.md", entry: "Anything", kind: "fact", recommendation: "keep" },
    // A heading is no entry.
    {
      file: "MEMORY.md",
      entry: "Grenzen",
      kind: "model-limit",
      recommendation: "archive",
    },
    // An unknown kind.
    {
      file: "MEMORY.md",
      entry: "Der Besitzer möchte keine Termine vor 9 Uhr vorgeschlagen bekommen.",
      kind: "guess",
      recommendation: "keep",
    },
    "not an object",
    {
      file: "memory/2026-11-02.md",
      entry: "Besitzer hat den Deploy-Termin für Release 2.16 auf Donnerstag gelegt.",
      kind: "fact",
      recommendation: "keep",
    },
  ]);
  const review = parseReview(answer, spikeFiles);
  assert.equal(review.dropped, 5);
  assert.deepEqual(review.entries, [
    {
      file: "memory/2026-11-02.md",
      entry: "Besitzer hat den Deploy-Termin für Release 2.16 auf Donnerstag gelegt.",
      kind: "fact",
      recommendation: "keep",
    },
  ]);
});

test("returns null on malformed JSON", () => {
  // Grok's second answer left the memory's straight quote unescaped.
  assert.equal(parseReview(spikeAnswers.grokUnescaped, spikeFiles), null);
  assert.equal(parseReview("I can't help with reviewing this memory.", spikeFiles), null);
  assert.equal(parseReview('{"file": "MEMORY.md"}', spikeFiles), null);
  assert.equal(parseReview('[{"file": "MEMORY.md"', spikeFiles), null);
  assert.equal(parseReview(undefined, spikeFiles), null);
});

test("finds the array after a lead-in, reasoning or a code fence", () => {
  const wrapped = `<think>[not this]</think>Here it is:\n\`\`\`json\n${spikeAnswers.grokCurly}\n\`\`\`\nDone [1].`;
  assert.equal(parseReview(wrapped, spikeFiles).entries.length, 10);
  assert.deepEqual(parseReview("[]", spikeFiles), { entries: [], dropped: 0 });
});

test("classifies an owner rule under a Limits heading as kept", () => {
  const review = parseReview(spikeAnswers.grokCurly, spikeFiles);
  const rule = review.entries.find((e) => e.entry.includes("vor 9 Uhr"));
  assert.deepEqual(rule, {
    file: "MEMORY.md",
    entry: "Der Besitzer möchte keine Termine vor 9 Uhr vorgeschlagen bekommen.",
    kind: "owner-rule",
    recommendation: "keep",
  });
});

test("an entry quoted twice counts once", () => {
  const entry = {
    file: "MEMORY.md",
    entry: "Der Besitzer schreibt auf Deutsch; Antworten auf Deutsch.",
    kind: "owner-rule",
    recommendation: "keep",
  };
  assert.deepEqual(parseReview(JSON.stringify([entry, entry]), spikeFiles), {
    entries: [entry],
    dropped: 0,
  });
});

test("a Hermes file's entries are its §-blocks", () => {
  const files = [
    {
      name: "MEMORY.md",
      content: "Owner: no mail without asking.\n§\nRefused a keylogger.",
    },
  ];
  const answer = JSON.stringify([
    {
      file: "MEMORY.md",
      entry: "Refused a keylogger.",
      kind: "model-limit",
      recommendation: "archive",
    },
  ]);
  assert.equal(parseReview(answer, files, "hermes").entries.length, 1);
});

test("the input names each file before its text; the task asks for exact entries", () => {
  assert.equal(
    reviewInput([
      { name: "MEMORY.md", content: "- a\n" },
      { name: "USER.md", content: "b" },
    ]),
    "=== MEMORY.md\n- a\n\n=== USER.md\nb",
  );
  for (const word of ["model-limit", "owner-rule", "fact", "archive", "keep", "JSON"])
    assert.ok(reviewInstructions.includes(word), word);
});
