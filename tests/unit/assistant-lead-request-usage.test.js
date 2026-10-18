import test from "node:test";
import assert from "node:assert/strict";
import { leadStoreFixture } from "../helpers/lead-request-fixture.js";
import {
  publicRequest,
  requestCaps,
} from "../../server/features/assistants/lead-request-store.js";
import { autonomousCaps } from "../../server/features/assistants/team-policy.js";
import {
  ownerConsent,
  parseOwnerText,
} from "../../server/features/assistants/lead-request-proof.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

// A lead with a permanent "Scout" and a temporary "Writer", at a team usage level.
function setup(t, usage) {
  const saved = { ...requestCaps };
  Object.assign(requestCaps, { perMinute: 1000, perTurn: 1000, open: 1000 });
  t.after(() => Object.assign(requestCaps, saved));
  const f = leadStoreFixture(t);
  const own = f.lead("Lead");
  const [scout, writer] = f.team(own, { count: 2, names: ["Scout", "Writer"] });
  f.promote(scout);
  const policy = f.teams.policy(own.assistant.id);
  if (usage) f.teams.savePolicy(own.assistant.id, { usage }, policy.revision);
  const request = (
    member,
    { type = "task", text = "Can you look at the budget?", context, quote, attempt } = {},
  ) => {
    const r = f.requests.create({
      type,
      attemptId: (attempt ?? f.turn(own.chat, text, context)).id,
      operationId: crypto.randomUUID(),
      input: {
        memberId: member.id,
        [type === "task" ? "task" : "question"]: "Review the budget",
        ...(quote ? { ownerRequested: true, ownerRequestQuote: quote } : {}),
      },
    });
    // Ended at once, so the next task may follow.
    f.teams.write(f.teams.get(r.id), { phase: "completed" });
    return r;
  };
  return { ...f, own, scout, writer, request };
}
const forwarded = { kind: "owner", forwarded: true };
const routine = { kind: "routine" };

test("a lead's own task writes only at the autonomous level, in the owner's turn", (t) => {
  for (const usage of ["onRequest", "suggest", "autonomous"]) {
    const f = setup(t, usage);
    const own = f.request(f.scout);
    assert.equal(own.writeAllowed, usage === "autonomous", usage);
    assert.equal(!!own.selfInitiated, usage === "autonomous", usage);
    assert.equal(!!publicRequest(own).selfInitiated, usage === "autonomous");
    // Forwarded and scheduled turns stay read-only at every level.
    for (const context of [forwarded, routine])
      assert.equal(f.request(f.scout, { context }).writeAllowed, false, usage);
    // The owner's explicit request writes at every level and is never self-initiated.
    const asked = f.request(f.scout, {
      text: "Please delegate the budget review to Scout",
      quote: "delegate the budget review to Scout",
    });
    assert.equal(asked.writeAllowed, true, usage);
    assert.equal(asked.selfInitiated, undefined, usage);
  }
});

test("the owner's short yes counts as the request where the lead offers members", (t) => {
  for (const usage of ["onRequest", "suggest", "autonomous"]) {
    const f = setup(t, usage);
    const yes = f.request(f.scout, { text: "Yes, go ahead!", quote: "Yes, go ahead" });
    assert.equal(!!yes.ownerProof?.consent, usage !== "onRequest", usage);
    assert.equal(yes.writeAllowed, usage !== "onRequest", usage);
    assert.equal(yes.selfInitiated, undefined, usage);
  }
  const f = setup(t, "suggest");
  const refused = [
    // Negated, limited, quoted, too long, or naming another member.
    ["No, not now", "No, not now"],
    ["Ok, but just read it", "Ok, but just read it"],
    ['She wrote "yes, go ahead"', "yes, go ahead"],
    [
      "Yes, and while you are at it please also prepare a summary of last week's numbers for me",
      "Yes",
    ],
    ["Yes, but ask Writer", "Yes"],
    // A yes the owner never wrote, and a forwarded one.
    ["What is the budget?", "Yes, go ahead"],
  ];
  for (const [text, quote] of refused)
    assert.equal(f.request(f.scout, { text, quote }).writeAllowed, false, text);
  assert.equal(
    f.request(f.scout, {
      text: "Ja, mach das",
      quote: "Ja, mach das",
      context: forwarded,
    }).writeAllowed,
    false,
  );
  // German, and one yes proves one task only.
  const attempt = f.turn(f.own.chat, "Ja, mach das");
  assert.equal(f.request(f.scout, { attempt, quote: "Ja, mach das" }).writeAllowed, true);
  assert.equal(
    f.request(f.scout, { attempt, quote: "Ja, mach das" }).writeAllowed,
    false,
  );
});

test("consent is a short, unnegated agreement in the owner's own prose", () => {
  const yes = (text, quote = text) => !!ownerConsent(quote, parseOwnerText(text));
  for (const text of [
    "Yes",
    "ok",
    "Sure, do it",
    "Klar, leg los",
    "Gerne!",
    "Sounds good",
  ])
    assert.equal(yes(text), true, text);
  for (const text of ["Please", "Maybe later", "Nein", "ok don't", "> yes", "`yes`"])
    assert.equal(yes(text), false, text);
  assert.equal(yes("Yes, go ahead", "go ahead"), true);
  assert.equal(yes("Yes, go ahead", "Yes, go"), true);
  assert.equal(yes("Yes, go ahead", "No"), false);
});

test("an autonomous lead starts only a few requests on its own per turn and hour", (t) => {
  const f = setup(t, "autonomous");
  const attempt = f.turn(f.own.chat, "What do we know about the market?");
  for (let n = 0; n < autonomousCaps.perTurn; n++)
    assert.equal(
      f.request(f.writer, { type: "question", attempt }).selfInitiated,
      true,
      `request ${n}`,
    );
  let refusal;
  assert.throws(
    () => f.request(f.writer, { type: "question", attempt }),
    (error) => {
      refusal = error;
      return error.status === 429 && error.key === "memberRequestAutonomousLimit";
    },
  );
  const tool = toolError(refusal);
  assert.equal(tool.code, "AUTONOMOUS_LIMIT");
  assert.match(tool.reason, new RegExp(`${autonomousCaps.perTurn} questions or tasks`));
  assert.match(tool.reason, /Do not retry/);
  // Requests the owner asked for by name are not the lead's own and still go.
  const named = f.request(f.writer, {
    type: "question",
    text: "Ask Writer about the market",
  });
  assert.equal(named.selfInitiated, undefined);
  // Per hour: new turns, until the hourly budget is used up.
  let made = autonomousCaps.perTurn;
  while (made < autonomousCaps.perHour) {
    f.request(f.writer, { type: "question" });
    made++;
  }
  assert.throws(() => f.request(f.writer, { type: "question" }), {
    key: "memberRequestAutonomousLimit",
  });
  // An hour later the budget is free again.
  for (const r of f.requests.list(f.own.assistant.id))
    f.teams.write(f.teams.get(r.id), {
      createdAt: new Date(Date.now() - 3600001).toISOString(),
    });
  assert.equal(f.request(f.writer, { type: "question" }).selfInitiated, true);
});

test("other levels never count against the autonomous budget", (t) => {
  const f = setup(t, "suggest");
  const attempt = f.turn(f.own.chat, "What do we know about the market?");
  for (let n = 0; n <= autonomousCaps.perTurn; n++)
    assert.equal(
      f.request(f.writer, { type: "question", attempt }).selfInitiated,
      undefined,
    );
});
