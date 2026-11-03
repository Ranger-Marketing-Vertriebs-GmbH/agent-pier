import test from "node:test";
import assert from "node:assert/strict";
import {
  ruleBody,
  ruleCappedText,
  ruleErrorText,
  rulesPath,
  ruleTone,
} from "../../web/features/projects/ticket-rules.js";
import { ruleInput } from "../../server/features/tickets/rule-input.js";
import * as de from "../../web/lib/i18n/de/ticket-rules.js";
import * as en from "../../web/lib/i18n/en/ticket-rules.js";
import * as deTickets from "../../web/lib/i18n/de/tickets.js";

const rule = {
  id: "r1",
  source: "github",
  label: "agent",
  kind: "session",
  options: {
    allowMerge: false,
    session: { tool: "codex", accountId: "local-codex", launchMode: "yolo" },
  },
  paused: false,
  createdAt: 1,
  updatedAt: 2,
  picked: 3,
  status: { checkedAt: 5, error: null },
};

test("rulesPath encodes the project and the rule", () => {
  assert.equal(rulesPath("m1"), "/tickets/projects/m1/rules");
  assert.equal(rulesPath("a/b", "r 1"), "/tickets/projects/a%2Fb/rules/r%201");
});

test("ruleTone maps paused and error", () => {
  assert.equal(ruleTone(rule), "neutral");
  assert.equal(ruleTone({ ...rule, paused: true }), "warning");
  const failed = { ...rule, status: { checkedAt: 5, error: { code: "x", since: 1 } } };
  assert.equal(ruleTone(failed), "error");
  assert.equal(ruleTone({ ...failed, paused: true }), "error");
});

test("ruleErrorText falls back to source codes", () => {
  // German is the default language of the catalogs outside a browser.
  for (const code of ["labelGone", "queueFull", "notConnected", "projectGone"])
    assert.equal(ruleErrorText(code), de.ticketRulesCopy.errors[code], code);
  assert.equal(ruleErrorText("forbidden"), deTickets.ticketErrorCopy.forbidden);
  assert.equal(ruleErrorText("rateLimited"), deTickets.ticketErrorCopy.rateLimited);
  assert.equal(ruleErrorText("toString"), deTickets.ticketErrorCopy.unavailable);
  assert.equal(ruleErrorText(undefined), deTickets.ticketErrorCopy.unavailable);
});

test("ruleBody flips paused only", () => {
  const body = ruleBody(rule, { paused: true });
  assert.deepEqual(body, {
    source: "github",
    label: "agent",
    kind: "session",
    paused: true,
    allowMerge: false,
    session: { tool: "codex", accountId: "local-codex", launchMode: "yolo" },
  });
  // The server reads it back as the same rule, paused.
  const checked = ruleInput(body);
  assert.deepEqual(checked, {
    source: "github",
    label: "agent",
    kind: "session",
    paused: true,
    options: rule.options,
  });
  assert.equal(ruleBody(rule).paused, false);
});

test("the rule catalogs match in keys and arguments", () => {
  const shape = (value) =>
    typeof value === "function"
      ? `fn${value.length}`
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
        : typeof value;
  assert.deepEqual(shape(de), shape(en));
  assert.equal(en.ticketRulesCopy.picked(1), "1 ticket picked up");
  assert.equal(en.ticketRulesCopy.picked(2), "2 tickets picked up");
});

test("ruleCappedText names the cap of the rule's source", () => {
  assert.equal(ruleCappedText(rule), "");
  const capped = { ...rule, status: { checkedAt: 5, error: null, capped: true } };
  assert.equal(ruleCappedText(capped), de.ticketRulesCopy.capped.github);
  assert.match(ruleCappedText(capped), /300/);
  assert.match(ruleCappedText({ ...capped, source: "plane" }), /500/);
  assert.match(en.ticketRulesCopy.capped.github, /300 open issues/);
  assert.match(en.ticketRulesCopy.capped.plane, /500 work items/);
});
