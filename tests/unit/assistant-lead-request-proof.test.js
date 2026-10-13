import test from "node:test";
import assert from "node:assert/strict";
import {
  intent,
  namesMember,
} from "../../server/features/assistants/lead-request-proof.js";

test("ask and delegate cues are recognised in German and English", () => {
  for (const quote of [
    "ask Scout about the budget",
    "please delegate the report to Scout",
    "assign Scout the migration",
    "frag Scout nach dem Budget",
    "frage bitte Scout",
    "Fragt Scout, was es kostet",
    "gib Scout die Planung an",
    "lass Scout den Bericht machen",
    "delegiere das an Scout",
    "beauftrage Scout mit dem Umzug",
    "übergib Scout die Aufgabe",
    "let Scout do the review",
    "hand the review over to Scout",
  ])
    assert.equal(intent(quote), true, quote);
  for (const quote of [
    "Scout found the budget",
    "a fragment of the plan",
    "the task list for Scout",
    "gib mir den Bericht",
    "lass das sein",
    "Summarize https://example.org/post for",
    "basket of tasks",
  ])
    assert.equal(intent(quote), false, quote);
});

test("a quote names a member by its whole name or a word only it carries", () => {
  assert.equal(namesMember("ask Market Scout now", "Market Scout"), true);
  assert.equal(namesMember("ask the scout now", "Market Scout", ["Writer"]), true);
  // "Market" is shared with another member, so it is ambiguous.
  assert.equal(
    namesMember("ask market about it", "Market Scout", ["Market Analyst"]),
    false,
  );
  assert.equal(namesMember("ask market scout", "Market Scout", ["Market Analyst"]), true);
  assert.equal(namesMember("ask the writer", "Market Scout", ["Writer"]), false);
  // A word inside another word is no name.
  assert.equal(namesMember("ask scouting team", "Scout"), false);
  assert.equal(namesMember("ask member 0", "Member 0", ["Member 1"]), true);
  assert.equal(namesMember("ask member 1", "Member 0", ["Member 1"]), false);
  assert.equal(namesMember("frag ÄRZTIN bitte", "Ärztin"), true);
});
