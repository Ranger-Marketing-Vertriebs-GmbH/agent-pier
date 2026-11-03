import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { TICKET_SOURCE_IDS } from "./ticket.js";
import { plainObject, sequenceOptionsInput } from "./ticket-start-input.js";

const copy = serverMessages.tickets;

/** A rule's label, trimmed, or null: 1–50 characters, no control character or comma. */
export function ruleLabel(value) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f,]/.test(value)) return null;
  const label = value.trim();
  if (!label || label.length > 50) return null;
  return label;
}

/** The body of a label rule: source, label and the options every queued ticket gets. */
export function ruleInput(input) {
  const invalid = () => problem(copy.invalidRule);
  if (!plainObject(input)) throw invalid();
  const { source, label, paused } = input;
  if (!TICKET_SOURCE_IDS.includes(source)) throw invalid();
  const checkedLabel = ruleLabel(label);
  if (!checkedLabel) throw problem(copy.invalidRuleLabel);
  if (paused !== undefined && typeof paused !== "boolean") throw invalid();
  const { kind, ...options } = sequenceOptionsInput(input, invalid);
  return { source, label: checkedLabel, kind, paused: paused === true, options };
}
