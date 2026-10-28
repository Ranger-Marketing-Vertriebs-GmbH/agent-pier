// The live `session.deliveries:<id>` signal topic, owner only like the chat delivery
// routes (GET /sessions/:id/input/:deliveryId). It sends `changed` whenever a
// delivery receipt of the session is written (reserved, pasted, handed off, held,
// rejected, cancelled, recovered), a held message leaves the queue, or the session's
// receipts are discarded. It carries no data: each chat reads the status of its own
// pending deliveries, which need the delivery scope the browser holds.

const owner = (principal) => principal?.role === "owner";

// The session ids ChatDelivery keeps receipts for (its folder names).
export const DELIVERY_SESSION_PARAM = /[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}/;

/** A delivery of `sessionId` changed: signals its topic on `hub` (services.live). */
export function deliveriesChanged(hub, sessionId) {
  if (typeof sessionId === "string") hub?.invalidate("session.deliveries", sessionId);
}

/** The `session.deliveries` signal topic definition for LiveHub#define. */
export function sessionDeliveriesTopic() {
  return {
    name: "session.deliveries",
    mode: "signal",
    param: DELIVERY_SESSION_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
  };
}
