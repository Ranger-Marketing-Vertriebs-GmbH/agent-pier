import { browserUuid } from "../../lib/browser-uuid.js";
import { getWorkerRegistration } from "./register-worker.js";

const key = "agentpier.notification-device";
const valid = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);

/** This browser's push device id, created on first use; null without storage. */
export function deviceIdentity() {
  try {
    let value = localStorage.getItem(key);
    if (!valid(value)) {
      value = browserUuid();
      localStorage.setItem(key, value);
    }
    return value;
  } catch {
    return null;
  }
}

/** The device id this browser already has, or undefined: sign-in and sign-out send it. */
export function knownDevice() {
  try {
    const value = localStorage.getItem(key);
    return valid(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Signing out ends this browser's push subscription: the server forgets the device for
 * the person who signs out, so the next person here never gets her notices. Her notices
 * already in the tray and her count on the app badge go too, so a shared tablet never
 * shows them to the next person.
 */
export async function endPushSubscription() {
  let registration = null;
  try {
    registration = await getWorkerRegistration();
  } catch {}
  await Promise.allSettled([
    unsubscribe(registration),
    closeNotices(registration),
    clearBadge(),
  ]);
}

async function unsubscribe(registration) {
  const subscription = await registration?.pushManager?.getSubscription();
  await subscription?.unsubscribe();
}

async function closeNotices(registration) {
  if (!registration?.getNotifications) return;
  for (const notice of await registration.getNotifications()) notice.close();
}

async function clearBadge() {
  if (typeof navigator !== "undefined" && navigator.clearAppBadge)
    await navigator.clearAppBadge();
}
