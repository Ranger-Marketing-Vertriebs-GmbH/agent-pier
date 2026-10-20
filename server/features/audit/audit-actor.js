/** Who acted, for audit events: user actions carry the user's id, the owner's none. */
export const auditActor = (principal) =>
  principal?.role === "user" && typeof principal.userId === "string"
    ? { actorUserId: principal.userId }
    : {};

const userKinds = new Set(["password-reset", "password-changed", "owner-may-read"]);

/** Copies the acting user and the user-account kinds; never names or passwords. */
export function userAuditDetails(input, event, auditId) {
  if (input.actorUserId !== undefined) event.actorUserId = auditId(input.actorUserId);
  if (input.resourceType === "user" && userKinds.has(input.details?.kind))
    event.details.kind = input.details.kind;
}
