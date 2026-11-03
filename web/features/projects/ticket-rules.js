// The label rules of a project as the Tickets tab shows them: their route, the tone of
// a rule's state, the text of its poll error and the body Pause, Resume and Edit send
// (server/features/tickets/rule-service.js).
import { ticketRulesCopy } from "../../lib/i18n/messages/ticket-rules.js";
import { ticketErrorCopy } from "../../lib/i18n/messages/tickets.js";

/** The rule route of a project, or of one of its rules. */
export function rulesPath(projectId, ruleId) {
  const base = `/tickets/projects/${encodeURIComponent(projectId)}/rules`;
  return ruleId ? `${base}/${encodeURIComponent(ruleId)}` : base;
}

/**
 * The state a rule's StatusChip shows: paused first, since a paused rule reads nothing
 * and its last error (still in the sub line) is not current; then an error.
 */
export const ruleState = (rule) =>
  rule?.paused ? "paused" : rule?.status?.error ? "failing" : "active";

const TONES = { paused: "warning", failing: "error", active: "neutral" };

/** The StatusChip tone of a rule's state. */
export const ruleTone = (rule) => TONES[ruleState(rule)];

const RULE_CODES = ["labelGone", "queueFull", "notConnected", "projectGone"];

/** A rule's own failure codes, else the source's; an unknown code reads "unavailable". */
export function ruleErrorText(code) {
  if (RULE_CODES.includes(code)) return ticketRulesCopy.errors[code];
  return (
    (Object.hasOwn(ticketErrorCopy, code) && ticketErrorCopy[code]) ||
    ticketErrorCopy.unavailable
  );
}

/**
 * The hint of a rule whose last pass read only the first page-capped open tickets of
 * its source (`status.capped`), or "": not an error, labelled tickets beyond the cap
 * are not seen.
 */
export function ruleCappedText(rule) {
  if (rule?.status?.capped !== true) return "";
  return rule.source === "plane"
    ? ticketRulesCopy.capped.plane
    : ticketRulesCopy.capped.github;
}

/** The PUT body of `rule` with `patch` applied: the server replaces the whole rule. */
export function ruleBody(rule, patch = {}) {
  return {
    source: rule.source,
    label: rule.label,
    kind: rule.kind,
    paused: rule.paused === true,
    ...rule.options,
    ...patch,
  };
}
