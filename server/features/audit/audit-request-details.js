import { requestActorDetails } from "./audit-agent-session-details.js";
import { endCauses } from "../requests/request-endings.js";

// A native CLI request (request-broker.js): who answered, why one ended without an
// answer (`cause`), whether it was a Claude startup screen rather than a tool
// permission (`startup`), and how a remembered or default approval answered it
// (`decision`, `auto`). Never a command, a path or a rule's text.
const decisions = ["allow-session", "allow-project", "allow-default"];

export function requestAuditDetails(details, event) {
  requestActorDetails(details, event);
  if (endCauses.includes(details.cause)) event.details.cause = details.cause;
  if (details.startup === true) event.details.startup = true;
  if (details.auto === true) event.details.auto = true;
  if (decisions.includes(details.decision)) event.details.decision = details.decision;
}
