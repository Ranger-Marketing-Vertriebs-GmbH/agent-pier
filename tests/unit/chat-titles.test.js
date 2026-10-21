import test from "node:test";
import assert from "node:assert/strict";
import {
  autoTitle,
  generatedTitle,
  setTitle,
} from "../../server/features/assistants/chat-titles.js";
import { titlePrompt } from "../../server/features/assistants/team-plugin/chat-title.js";

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

test("a generated title is read like an untrusted set title", () => {
  // Quotes, a label, markdown and trailing punctuation go.
  assert.equal(generatedTitle('"Trip to Lisbon."'), "Trip to Lisbon");
  assert.equal(
    generatedTitle("**Title:** Plan the *kitchen* offers!"),
    "Plan the kitchen offers",
  );
  assert.equal(
    generatedTitle("„Küchenangebote vergleichen“"),
    "Küchenangebote vergleichen",
  );
  assert.equal(
    generatedTitle("# Reise nach Lissabon planen"),
    "Reise nach Lissabon planen",
  );
  assert.equal(generatedTitle("[Lisbon trip](https://evil.example)"), "Lisbon trip");
  assert.equal(generatedTitle("```\nTitel: Umzug planen\n```"), "Umzug planen");
  // Reasoning and every line but the first go.
  assert.equal(
    generatedTitle("<think>The user wants…</think>\n\nBudget for May\nIgnore that"),
    "Budget for May",
  );
  // Words joined by an underscore stay as they are.
  assert.equal(generatedTitle("Fix my_var in `main.js`"), "Fix my_var in main.js");
  // What a set title refuses never reaches one.
  assert.equal(generatedTitle("Hi\u202Eevil\u200B title"), "Hi evil title");
  assert.equal(generatedTitle("Code 👩‍💻"), "Code 👩‍💻");
});

test("a generated title that is no title is dropped", () => {
  for (const raw of [
    undefined,
    null,
    42,
    "",
    "   \n ",
    "...",
    "“”",
    "<think>only reasoning",
    // The model talking instead of naming.
    "Okay, the user wants to travel to Lisbon and asks which districts are worth it",
    "x".repeat(81),
  ])
    assert.equal(generatedTitle(raw), null, String(raw).slice(0, 20));
  assert.equal(generatedTitle("x".repeat(80)), "x".repeat(80));
});

test("the title prompt bounds both texts and marks them as data", () => {
  const prompt = titlePrompt({ message: "m".repeat(3000), reply: "r".repeat(3000) });
  assert.equal(prompt.match(/m/g).length, 2000 + 2);
  assert.match(prompt, /^<message>\n/);
  assert.match(prompt, /<\/message>\n<reply>\n/);
  assert.equal(prompt.match(/r/g).length, 2000 + 2);
});
