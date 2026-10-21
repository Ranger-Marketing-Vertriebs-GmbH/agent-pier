import test from "node:test";
import assert from "node:assert/strict";
import { autoTitle, setTitle } from "../../server/features/assistants/chat-titles.js";

test("auto title cuts at a word", () => {
  assert.equal(autoTitle("  Plan   the\ntrip to Lisbon  "), "Plan the trip to Lisbon");
  const long =
    "Please help me compare the three offers for the new kitchen and pick the cheapest one";
  const title = autoTitle(long);
  assert.equal(title, "Please help me compare the three offers for the new kitchen…");
  assert.ok([...title].length <= 60);
  // One unbroken word is cut where it must be.
  const word = "x".repeat(80);
  assert.equal(autoTitle(word), `${"x".repeat(59)}…`);
  // Emoji count as one character each.
  assert.equal([...autoTitle("😀".repeat(70))].length, 60);
});

test("empty and attachment-only messages have no auto title", () => {
  assert.equal(autoTitle(""), null);
  assert.equal(autoTitle("   \n\t "), null);
  assert.equal(autoTitle(undefined), null);
  // Control characters never reach a title.
  assert.equal(autoTitle("Hi\u0000 there‮"), "Hi there");
});

test("a set title is 1 to 80 characters without control characters", () => {
  assert.equal(setTitle("  Holiday  "), "Holiday");
  assert.equal(setTitle("x".repeat(80)), "x".repeat(80));
  assert.equal(setTitle(""), "");
  for (const value of ["x".repeat(81), "a\nb", "a\u0007b", 5, null, ["a"]])
    assert.throws(() => setTitle(value), { status: 400 });
});

test("a set title refuses what an auto title strips", () => {
  // Bidi overrides and isolates, zero-width spaces, a BOM and a line separator.
  for (const hidden of ["\u202E", "\u2066", "\u200B", "\u200E", "\uFEFF", "\u2028"]) {
    assert.throws(() => setTitle(`Hi${hidden}evil`), { status: 400 }, escape(hidden));
    assert.equal(autoTitle(`Hi${hidden}evil`), "Hi evil");
  }
  // Emoji built with zero-width joiners stay whole in both.
  assert.equal(setTitle("Code 👩‍💻"), "Code 👩‍💻");
  assert.equal(autoTitle("Code 👩‍💻"), "Code 👩‍💻");
});
