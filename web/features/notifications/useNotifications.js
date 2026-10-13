import { useEffect, useState, useRef } from "react";
import api from "../../lib/api.js";
import { serverMessagesReady, serverText } from "../../lib/server-messages.js";
import { browserUuid } from "../../lib/browser-uuid.js";
import useResource from "../../lib/useResource.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { notificationCopy as copy } from "../../lib/i18n/messages/notifications.js";
import { getWorkerRegistration } from "./register-worker.js";
import { currentDevice, isLegacyLabel } from "./device-labels.js";
function deviceIdentity() {
  const key = "agentpier.notification-device";
  try {
    let value = localStorage.getItem(key);
    if (!value || !/^[a-f0-9-]{36}$/i.test(value)) {
      value = browserUuid();
      localStorage.setItem(key, value);
    }
    return value;
  } catch {
    return null;
  }
}
function applicationKey(value) {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
export default function useNotifications() {
  const resource = useResource("/notifications"),
    action = useAsyncAction();
  const subscriptionGeneration = useRef(0);
  const [deviceId] = useState(deviceIdentity),
    [subscription, setSubscription] = useState(null);
  const [device] = useState(currentDevice),
    derivedName = copy.deviceName(device.browser, device.platform, device.app);
  const [label, setLabel] = useState(derivedName),
    [message, setMessage] = useState(""),
    // Where the last action's error belongs: "device", "test" or a subscription id.
    [scope, setScope] = useState(null);
  const supported =
    globalThis.isSecureContext &&
    "Notification" in window &&
    "PushManager" in window &&
    "serviceWorker" in navigator;
  const [permission, setPermission] = useState(() =>
    supported ? Notification.permission : "denied",
  );
  const own = resource.data?.subscriptions?.find((item) => item.deviceId === deviceId);
  // The name field starts with this device's stored name once it is known; a legacy
  // fixed name is replaced by the derived one (stored only when the owner saves it).
  const named = useRef(null);
  useEffect(() => {
    if (!own || named.current === own.id) return;
    named.current = own.id;
    setLabel(isLegacyLabel(own.label) || !own.label?.trim() ? derivedName : own.label);
  }, [own, derivedName]);
  const run = (where, work) => {
    setScope(where);
    return action.run(work);
  };
  useEffect(() => {
    let disposed = false;
    const generation = subscriptionGeneration.current;
    getWorkerRegistration()
      .then((registration) => registration?.pushManager.getSubscription())
      .then((value) => {
        if (!disposed && generation === subscriptionGeneration.current)
          setSubscription(value || null);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);
  const updateSubscriptions = (subscriptions) =>
    resource.update({ ...resource.data, subscriptions });
  const enable = () =>
    run("device", async () => {
      setMessage("");
      if (!deviceId) throw new Error(copy.storageFailed);
      const allowed =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
      setPermission(allowed);
      if (allowed !== "granted") throw new Error(copy.permissionRequired);
      const registration = await getWorkerRegistration({ create: true });
      let current = await registration.pushManager.getSubscription();
      if (!current)
        current = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationKey(resource.data.publicKey),
        });
      subscriptionGeneration.current++;
      setSubscription(current);
      const result = await api("/notifications/subscriptions", "POST", {
        deviceId,
        label: label.trim() || derivedName,
        subscription: current.toJSON(),
      });
      updateSubscriptions([
        ...(resource.data.subscriptions || []).filter(
          (item) => item.deviceId !== deviceId,
        ),
        result.subscription,
      ]);
    });
  const remove = (entry = own) =>
    run(!entry || entry.deviceId === deviceId ? "device" : entry.id, async () => {
      setMessage("");
      if (entry) {
        await api(
          `/notifications/subscriptions/${encodeURIComponent(entry.id)}`,
          "DELETE",
        );
        updateSubscriptions(
          resource.data.subscriptions.filter((item) => item.id !== entry.id),
        );
      }
      if (!entry || entry.deviceId === deviceId) {
        try {
          const registration = subscription ? null : await getWorkerRegistration();
          const current =
            subscription || (await registration?.pushManager.getSubscription());
          subscriptionGeneration.current++;
          if (current) setSubscription(current);
          if (current && !(await current.unsubscribe()))
            throw new Error(copy.unsubscribeFailed);
          setSubscription(null);
        } catch {
          throw new Error(copy.unsubscribeFailed);
        }
      }
    });
  const test = () =>
    run("test", async () => {
      setMessage("");
      const result = await api("/notifications/test", "POST", { subscriptionId: own.id });
      if (!result.sent) {
        await serverMessagesReady();
        throw new Error(serverText(result.error) || copy.testFailed);
      }
      setMessage(copy.sent);
    });
  return {
    resource,
    action,
    label,
    setLabel,
    message,
    supported,
    permission,
    own,
    subscription,
    deviceId,
    derivedName,
    errorFor: (where) => (scope === where ? action.error : ""),
    renamed: Boolean(own && label.trim() && label.trim() !== own.label),
    active: Boolean(own && subscription && permission === "granted"),
    enable,
    remove,
    test,
  };
}
