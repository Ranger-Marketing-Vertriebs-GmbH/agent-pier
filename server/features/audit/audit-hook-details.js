// Audit details of agent hooks (agent-hooks.js) and of what a hook run did: ids,
// enums and sizes only. A delivery never keeps its payload, headers or secret, a
// change never keeps a hook's name, sender or instruction.
import { hookDefaults } from "../assistants/agent-hook-rights.js";

const outcomes = [
  "accepted",
  "duplicate",
  "throttled",
  "unauthorized",
  "not-found",
  "too-large",
  "invalid",
  "unavailable",
];
const branches = ["local", "tailscale", "network", "test"];
const changes = ["create", "update", "secret", "delete", "enable", "pause"];
const rightKeys = Object.keys(hookDefaults);
// The sender's event id as eventIdOf keeps it, or the body hash it falls back to.
const eventKey = (value) =>
  typeof value === "string" &&
  (/^sha256:[a-f0-9]{64}$/.test(value) ||
    (value.length >= 1 &&
      value.length <= 200 &&
      !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)));

export function hookAuditDetails(details, event, auditId) {
  for (const key of ["hookId", "hookEventId"])
    if (details[key] !== undefined) event.details[key] = auditId(details[key]);
  // A hook run's own writes (native-write, project-file) say they came from a hook.
  if (details.via === "hook") event.details.via = "hook";
  if (details.kind === "hook-delivery") {
    if (eventKey(details.eventKey)) event.details.eventKey = details.eventKey;
    if (outcomes.includes(details.outcome)) event.details.outcome = details.outcome;
    if (branches.includes(details.branch)) event.details.branch = details.branch;
    if (Number.isSafeInteger(details.size) && details.size >= 0)
      event.details.size = details.size;
  }
  if (details.kind === "hook") {
    if (changes.includes(details.change)) event.details.change = details.change;
    // The rights above a new hook's defaults, by name; never hosts or folders.
    if (Array.isArray(details.rights))
      event.details.rights = rightKeys.filter((key) => details.rights.includes(key));
  }
}
