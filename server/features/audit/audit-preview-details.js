// Session and agent previews (preview-service.js): the owner kind, the target port, the
// slot and why it ended. Never a URL, a path, a label or a header.
const owners = ["session", "agent"];
const reasons = [
  "tool",
  "owner",
  "session",
  "revoked",
  "conversation",
  "disabled",
  "range",
  "expired",
];
const port = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;

export function previewAuditDetails(details, event) {
  if (owners.includes(details.owner)) event.details.owner = details.owner;
  for (const key of ["targetPort", "slot"])
    if (port(details[key])) event.details[key] = details[key];
  if (reasons.includes(details.reason)) event.details.reason = details.reason;
}
