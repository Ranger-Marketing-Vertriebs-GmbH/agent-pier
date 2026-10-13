import { operationsFixture } from "./operations-fixture.js";

export const ownDeviceId = "0f6c2b8e-6a1d-4f5e-9a51-3c1e2d7b4a90";

// A browser push stack (permission, worker registration, push manager) and the
// /api/notifications routes, all in memory.
export async function notifications(
  page,
  { deferInitialRead = false, subscriptions = [], device = null } = {},
) {
  const state = {
    subscriptions: subscriptions.map((entry) => ({ ...entry })),
    failSave: false,
    failDelete: false,
    calls: [],
  };
  await operationsFixture(page);
  await page.addInitScript(
    ({ deferInitialRead, device, ownDeviceId }) => {
      const state = {
        permissionCalls: 0,
        unsubscribeCalls: 0,
        subscription: null,
        reads: 0,
        resolveInitial: null,
      };
      window.__pushFixture = state;
      const subscription = {
        toJSON: () => ({
          endpoint: "https://push.example.invalid/device",
          keys: { p256dh: "fixture", auth: "fixture" },
        }),
        unsubscribe: async () => {
          state.unsubscribeCalls++;
          if (state.failUnsubscribe) throw Error("Fixture browser unsubscribe failed");
          state.subscription = null;
          return true;
        },
      };
      if (device) {
        // A device that is already subscribed, with a fixed browser identity.
        localStorage.setItem("agentpier.notification-device", ownDeviceId);
        if (device.subscribed) state.subscription = subscription;
        Object.defineProperty(navigator, "userAgent", {
          configurable: true,
          get: () => device.userAgent,
        });
        Object.defineProperty(navigator, "userAgentData", {
          configurable: true,
          get: () => undefined,
        });
      }
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value: {
          permission: device?.subscribed ? "granted" : "default",
          requestPermission: async () => {
            state.permissionCalls++;
            window.Notification.permission = "granted";
            return "granted";
          },
        },
      });
      Object.defineProperty(window, "PushManager", {
        configurable: true,
        value: function () {},
      });
      const registration = {
        pushManager: {
          getSubscription: async () => {
            state.reads++;
            if (deferInitialRead && state.permissionCalls === 0)
              return new Promise((resolve) => {
                state.resolveInitial = resolve;
              });
            return state.subscription;
          },
          subscribe: async () => {
            state.subscription = subscription;
            return subscription;
          },
        },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: Object.assign(new EventTarget(), {
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
          register: async () => registration,
        }),
      });
    },
    { deferInitialRead, device, ownDeviceId },
  );
  await page.route("**/api/notifications**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method(),
      body = method === "POST" ? request.postDataJSON() : null;
    state.calls.push({ path, method, body });
    if (method === "POST" && path.endsWith("/subscriptions")) {
      if (state.failSave)
        return route.fulfill({
          status: 500,
          json: { error: "Fixture persistence failed" },
        });
      const existing = state.subscriptions.find(
        (entry) => entry.deviceId === body.deviceId,
      );
      const summary = {
        ...existing,
        id: existing?.id || "subscription-one",
        deviceId: body.deviceId,
        label: body.label,
        createdAt: existing?.createdAt || "2026-09-07T12:00:00Z",
      };
      state.subscriptions = [
        ...state.subscriptions.filter((entry) => entry.deviceId !== body.deviceId),
        summary,
      ];
      return route.fulfill({ json: { subscription: summary } });
    }
    if (method === "DELETE") {
      if (state.failDelete)
        return route.fulfill({ status: 409, json: { error: "Fixture delete failed" } });
      const id = decodeURIComponent(path.split("/").pop());
      state.subscriptions = state.subscriptions.filter((entry) => entry.id !== id);
      return route.fulfill({ json: { removed: true } });
    }
    if (path.endsWith("/test"))
      return route.fulfill({ json: state.testResult || { sent: true } });
    return route.fulfill({
      json: { enabled: true, publicKey: "AQIDBA", subscriptions: state.subscriptions },
    });
  });
  return state;
}
