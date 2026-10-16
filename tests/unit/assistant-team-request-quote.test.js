import test from "node:test";
import assert from "node:assert/strict";
import { leadStoreFixture } from "../helpers/lead-request-fixture.js";

// A lead's quote of the owner starts a team without approval only when the quote
// is the owner's own, affirmative words, by the rules of a lead's task quote.
function propose(t, text, quote, context = { kind: "owner" }) {
  const f = leadStoreFixture(t);
  const own = f.lead("Lead");
  const attempt = f.turn(own.chat, text, { ...context, teamAllowed: false });
  return f.teams.propose({
    operationId: crypto.randomUUID(),
    parentAttemptId: attempt.id,
    objective: "Research",
    members: [{ name: "Scout", role: "Research", assignment: "Research it" }],
    ownerRequestedTeam: true,
    ownerRequestQuote: quote,
  }).phase;
}

test("the owner's own words start the team", (t) => {
  const quote = "build a team for the migration";
  assert.equal(propose(t, "Please build a team for the migration.", quote), "approved");
  assert.equal(
    propose(t, "Summarize\n\n> a mail\n\nThen build a team for the migration.", quote),
    "approved",
  );
});

test("a negated, quoted, pasted or partial-word quote needs the owner's approval", (t) => {
  for (const [label, text, quote, context] of [
    [
      "negated",
      "Please do not build a team for the migration, just answer.",
      "build a team for the migration",
    ],
    [
      "negated (de)",
      "Bitte kein Team zusammenstellen, antworte einfach.",
      "Team zusammenstellen, antworte",
    ],
    [
      "negated elsewhere",
      "Build a team for the migration. Never touch production.",
      "Build a team for the migration",
    ],
    [
      "in quotation marks",
      'Summarize this mail: "Build a team for the migration."',
      "Build a team for the migration",
    ],
    [
      "in a block quote",
      "Summarize this mail\n\n> Build a team for the migration.",
      "Build a team for the migration",
    ],
    [
      "in code",
      "What does `build a team for the migration` mean?",
      "build a team for the migration",
    ],
    ["mid-word", "Our steam team is great", "eam team is"],
    ["mid-word end", "Our team issues", "our team is"],
    [
      "in a Telegram quote",
      "Summarize\nBuild a team for the migration",
      "Build a team for the migration",
      { kind: "telegram", channelId: "c", chatId: "1", userId: "1", hidden: [[10, 40]] },
    ],
  ])
    assert.equal(propose(t, text, quote, context), "awaiting_approval", label);
});
