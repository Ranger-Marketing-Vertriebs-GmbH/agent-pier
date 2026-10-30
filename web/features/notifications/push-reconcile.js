import api from "../../lib/api.js";
import { getWorkerRegistration } from "./register-worker.js";
import { knownDevice } from "./device-identity.js";
import { currentDevice } from "./device-labels.js";
import { notificationCopy as copy } from "../../lib/i18n/messages/notifications.js";

// Keeps this browser's push device registered without the owner noticing the gap: a
// browser that still holds its subscription (and the permission) but which the server
// forgot, or whose subscription the browser renewed, registers again on load and after
// sign-in. Only the person who enabled notifications in this browser gets it back.

const personKey = "agentpier.notification-person";

/** The notification API a person's devices use: the owner's or a user's own. */
export const notificationBase = (person) =>
  person === "owner" ? "/notifications" : "/me/notifications";

export function pushSupported() {
  return Boolean(
    globalThis.isSecureContext &&
    typeof window !== "undefined" &&
    "Notification" in window &&
    "PushManager" in window &&
    "serviceWorker" in navigator,
  );
}

function storedPerson() {
  try {
    return localStorage.getItem(personKey);
  } catch {
    return null;
  }
}

/**
 * Remembers who enabled notifications in this browser and tells the service worker
 * which device to renew (pushsubscriptionchange); null forgets both (sign-out).
 */
export async function rememberPushDevice(person, deviceId) {
  try {
    if (person) localStorage.setItem(personKey, person);
    else localStorage.removeItem(personKey);
  } catch {}
  try {
    const registration = await getWorkerRegistration();
    registration?.active?.postMessage({
      type: "agentpier-device",
      ...(person && deviceId ? { deviceId, base: notificationBase(person) } : {}),
    });
  } catch {}
}

export function applicationKey(value) {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

// Whether a subscription was made with the server's current sender key.
function sameKey(subscription, publicKey) {
  const key = subscription?.options?.applicationServerKey;
  if (!key) return true;
  const bytes = new Uint8Array(key);
  const expected = applicationKey(publicKey);
  return bytes.length === expected.length && bytes.every((b, i) => b === expected[i]);
}

function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

async function reconcile(person) {
  const deviceId = knownDevice();
  if (!pushSupported() || Notification.permission !== "granted" || !deviceId)
    return "skipped";
  const registration = await getWorkerRegistration();
  if (!registration?.pushManager) return "skipped";
  const base = notificationBase(person);
  const status = await api(base);
  const own = status.subscriptions?.find((item) => item.deviceId === deviceId);
  let current = await registration.pushManager.getSubscription();
  // Another person's subscription in this browser is never taken over silently.
  const marker = storedPerson();
  if (!own && (!current || (marker && marker !== person))) return "skipped";
  if (current && !sameKey(current, status.publicKey)) {
    await current.unsubscribe().catch(() => {});
    current = null;
  }
  if (!current)
    current = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationKey(status.publicKey),
    });
  if (own)
    await api(`${base}/renew`, "POST", { deviceId, subscription: current.toJSON() });
  else {
    const device = currentDevice();
    await api(`${base}/subscriptions`, "POST", {
      deviceId,
      label: copy.deviceName(device.browser, device.platform, device.app),
      subscription: current.toJSON(),
      timeZone: timeZone(),
    });
  }
  await rememberPushDevice(person, deviceId);
  return own ? "renewed" : "registered";
}

const runs = new Map();

/**
 * Runs once per page load and person ("owner" or `user:<id>`); resolves to
 * "skipped", "renewed" or "registered", and to "failed" instead of throwing.
 */
export function reconcilePush(person) {
  if (!runs.has(person))
    runs.set(
      person,
      reconcile(person).catch(() => "failed"),
    );
  return runs.get(person);
}
