import test from "node:test";
import assert from "node:assert/strict";
import { endPushSubscription } from "../../web/features/notifications/device-identity.js";

function stubBrowser(registration) {
  const calls = { badge: 0 };
  const saved = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    isSecureContext: Object.getOwnPropertyDescriptor(globalThis, "isSecureContext"),
  };
  Object.defineProperty(globalThis, "isSecureContext", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: { getRegistration: async () => registration },
      clearAppBadge: async () => {
        calls.badge += 1;
      },
    },
  });
  const restore = () => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
  return { calls, restore };
}

test("signing out closes her notices, clears the badge and ends the subscription", async () => {
  const closed = [];
  let unsubscribed = 0;
  const notice = (tag) => ({ tag, close: () => closed.push(tag) });
  const registration = {
    pushManager: {
      getSubscription: async () => ({ unsubscribe: async () => (unsubscribed += 1) }),
    },
    getNotifications: async () => [notice("check-in"), notice("approval")],
  };
  const { calls, restore } = stubBrowser(registration);
  try {
    await endPushSubscription();
  } finally {
    restore();
  }
  assert.deepEqual(closed, ["check-in", "approval"]);
  assert.equal(calls.badge, 1);
  assert.equal(unsubscribed, 1);
});

test("signing out still clears notices and the badge when unsubscribing fails", async () => {
  const closed = [];
  const registration = {
    pushManager: {
      getSubscription: async () => {
        throw new Error("push service unavailable");
      },
    },
    getNotifications: async () => [{ close: () => closed.push("check-in") }],
  };
  const { calls, restore } = stubBrowser(registration);
  try {
    await endPushSubscription();
  } finally {
    restore();
  }
  assert.deepEqual(closed, ["check-in"]);
  assert.equal(calls.badge, 1);
});

test("signing out without a service worker still clears the badge", async () => {
  const { calls, restore } = stubBrowser(undefined);
  try {
    await endPushSubscription();
  } finally {
    restore();
  }
  assert.equal(calls.badge, 1);
});
