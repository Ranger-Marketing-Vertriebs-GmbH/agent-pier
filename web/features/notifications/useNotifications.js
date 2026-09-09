import { useEffect, useState, useRef } from "react";
import api from "../../lib/api.js";
import useResource from "../../lib/useResource.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { notificationCopy as copy } from "../../lib/i18n/messages/notifications.js";
import { getWorkerRegistration } from "./register-worker.js";
function deviceIdentity() {
  const key = "agentpier.notification-device";
  try {
    let value = localStorage.getItem(key);
    if (!value || !/^[a-f0-9-]{36}$/i.test(value)) {
      value = crypto.randomUUID();
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
  const [label, setLabel] = useState(copy.defaultDevice),
    [message, setMessage] = useState("");
  const supported =
    globalThis.isSecureContext &&
    "Notification" in window &&
    "PushManager" in window &&
    "serviceWorker" in navigator;
  const [permission, setPermission] = useState(() =>
    supported ? Notification.permission : "denied",
  );
  const own = resource.data?.subscriptions?.find((item) => item.deviceId === deviceId);
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
    action.run(async () => {
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
        label: label.trim() || copy.defaultDevice,
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
    action.run(async () => {
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
    action.run(async () => {
      setMessage("");
      const result = await api("/notifications/test", "POST", { subscriptionId: own.id });
      if (!result.sent) throw new Error(result.error || copy.testFailed);
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
    active: Boolean(own && subscription && permission === "granted"),
    enable,
    remove,
    test,
  };
}
