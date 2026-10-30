// A push device AgentPier removed on its own (push-delivery-log.js): why, and the push
// service's status code for an expired subscription. Never its endpoint, keys or name.
export const removalReasons = [
  // The push service answered 404 or 410: the browser dropped the subscription.
  "expired",
  // The browser signed out, or someone else signed in on it.
  "signed-out",
  "signed-in-elsewhere",
  // The owner reset a user's password, turned her sign-in off or deleted her.
  "user-signed-out",
];

export function notificationAuditDetails(details, event) {
  if (removalReasons.includes(details.reason)) event.details.reason = details.reason;
  if (
    Number.isSafeInteger(details.statusCode) &&
    details.statusCode >= 100 &&
    details.statusCode <= 599
  )
    event.details.statusCode = details.statusCode;
}
