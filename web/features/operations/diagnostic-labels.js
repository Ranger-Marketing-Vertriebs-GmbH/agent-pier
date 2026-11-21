import { diagnosticCopy as copy } from "../../lib/i18n/messages/operations.js";

// Checks named after a thing: their prefix and its label.
const prefixes = [
  ["account.", () => copy.account],
  ["project.", () => copy.project],
  ["adapter-session.", () => copy.adapterSession],
  ["provider-connection.", () => copy.providerConnection],
];

/**
 * The heading of a check: a fixed check by its id, a check of a thing by its kind
 * and the thing's name (`subject`), or its id when the server sent no name.
 */
export function checkLabel(check) {
  const id = typeof check === "string" ? check : check.id;
  if (copy.checks[id]) return copy.checks[id];
  for (const [prefix, label] of prefixes)
    if (id.startsWith(prefix))
      return `${label()}: ${(typeof check === "object" && check.subject) || id.slice(prefix.length)}`;
  return id;
}

/** The summary in the UI language by its stable id; the server's English otherwise. */
export function summaryText(check) {
  const text = check.summaryId && copy.summaries[check.summaryId];
  if (typeof text === "function") return text(...(check.summaryArgs || []));
  if (typeof text === "string") return text;
  return check.summary;
}

// A remedy is shown only for checks that need action, translated by its stable id.
export function remedyText(check) {
  if (check.status !== "warn" && check.status !== "fail") return null;
  if (check.remedyId && copy.remedies[check.remedyId])
    return copy.remedies[check.remedyId];
  return typeof check.remedy === "string" && check.remedy ? check.remedy : null;
}
