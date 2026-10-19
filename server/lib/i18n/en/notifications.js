/** English counterpart of de/notifications.js with identical keys. */
export const notifications = Object.freeze({
  unavailable: "Notifications are unavailable.",
  deviceLabelTooLong: "Notification device labels are limited to 80 characters.",
  deviceLimit: "Remove an old notification device first.",
  deviceNotRegistered: "Notification device is no longer registered.",
  deliveryFailed: "Delivery failed. Try a test notification.",
  deliveryFailedWithReason: (detail) =>
    `Delivery failed (${detail}). Try a test notification.`,
  refusedSignature: (code) =>
    `The push service rejected the sender identification (${code}). Update AgentPier and send a test notification.`,
  refusedExpiredSignature: (code) =>
    `The push service considers the sender signature expired (${code}). Check the server's system clock.`,
  refusedKey: (code) =>
    `This device was registered with a different sender key (${code}). Turn notifications on again on this device.`,
  refusedRateLimit: (code) =>
    `The push service reports too many requests (${code}). Try again later.`,
  refusedPayload: (code) =>
    `The notification is too large for the push service (${code}).`,
  refusedRequest: (code) => `The push service rejected the request as invalid (${code}).`,
  refusedUnavailable: (code) =>
    `The push service is temporarily unavailable (${code}). Try again later.`,
  notDelivered:
    "Notification could not be delivered. Check this device's permission and subscription.",
  invalidId: "Invalid notification identifier.",
  invalidSubscriptionKey: "Invalid push subscription key.",
  invalidSubscription: "Invalid push subscription.",
  invalidEndpoint: "Invalid push endpoint.",
  publicHttpsRequired: "Push requires a public HTTPS endpoint.",
  invalidPublicKey: "Invalid push public key.",
  invalidPreferences: "Invalid notification settings.",
});
