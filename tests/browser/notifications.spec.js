import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
async function notifications(page, deferInitialRead = false) {
  const state = { subscriptions: [], failSave: false, failDelete: false, calls: [] };
  await operationsFixture(page);
  await page.addInitScript((deferInitialRead) => {
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
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: {
        permission: "default",
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
      value: {
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
        register: async () => registration,
      },
    });
  }, deferInitialRead);
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
      const summary = {
        id: "subscription-one",
        deviceId: body.deviceId,
        label: body.label,
        createdAt: "2026-09-07T12:00:00Z",
      };
      state.subscriptions = [summary];
      return route.fulfill({ json: { subscription: summary } });
    }
    if (method === "DELETE") {
      if (state.failDelete)
        return route.fulfill({ status: 409, json: { error: "Fixture delete failed" } });
      state.subscriptions = [];
      return route.fulfill({ json: { removed: true } });
    }
    if (path.endsWith("/test")) return route.fulfill({ json: { sent: true } });
    return route.fulfill({
      json: { enabled: true, publicKey: "AQIDBA", subscriptions: state.subscriptions },
    });
  });
  return state;
}
test("notifications require explicit permission and successful persistence before showing enabled", async ({
  page,
}) => {
  const state = await notifications(page);
  state.failSave = true;
  await page.goto(baseURL + "/settings/notifications");
  await expect(
    page.getByRole("heading", { name: "App & Benachrichtigungen", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__pushFixture.permissionCalls)).toBe(0);
  await page
    .getByRole("button", { name: "Benachrichtigungen aktivieren", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Fixture persistence failed");
  await expect(
    page.getByText("Auf diesem Gerät aktiviert.", { exact: true }),
  ).toHaveCount(0);
  state.failSave = false;
  await page
    .getByRole("button", { name: "Benachrichtigungen aktivieren", exact: true })
    .click();
  await expect(
    page.getByText("Auf diesem Gerät aktiviert.", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__pushFixture.permissionCalls)).toBe(1);
  await page
    .getByRole("button", { name: "Testbenachrichtigung senden", exact: true })
    .click();
  await expect(
    page.getByText("Testbenachrichtigung versendet.", { exact: true }),
  ).toBeVisible();
});
test("mobile notification revocation keeps a failed server deletion retryable before local unsubscribe", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await notifications(page);
  await page.goto(baseURL + "/settings/notifications");
  await page
    .getByRole("button", { name: "Benachrichtigungen aktivieren", exact: true })
    .click();
  await expect(
    page.getByText("Auf diesem Gerät aktiviert.", { exact: true }),
  ).toBeVisible();
  state.failDelete = true;
  await page
    .getByRole("button", { name: "Benachrichtigungen deaktivieren", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Fixture delete failed");
  expect(await page.evaluate(() => window.__pushFixture.unsubscribeCalls)).toBe(0);
  state.failDelete = false;
  await page.evaluate(() => {
    window.__pushFixture.failUnsubscribe = true;
  });
  await page
    .getByRole("button", { name: "Benachrichtigungen deaktivieren", exact: true })
    .click();
  await expect(
    page.getByText("Auf diesem Gerät aktiviert.", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(
    "Die Server-Anmeldung wurde entfernt.",
  );
  expect(await page.evaluate(() => window.__pushFixture.unsubscribeCalls)).toBe(1);
  await page.evaluate(() => {
    window.__pushFixture.failUnsubscribe = false;
  });
  await page
    .getByRole("button", { name: "Benachrichtigungen deaktivieren", exact: true })
    .click();
  expect(await page.evaluate(() => window.__pushFixture.unsubscribeCalls)).toBe(2);
  expect(state.calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("an initial subscription read cannot overwrite a later successful opt-in", async ({
  page,
}) => {
  await notifications(page, true);
  await page.goto(baseURL + "/settings/notifications");
  await page.waitForFunction(() => Boolean(window.__pushFixture.resolveInitial));
  await page
    .getByRole("button", { name: "Benachrichtigungen aktivieren", exact: true })
    .click();
  await expect(
    page.getByText("Auf diesem Gerät aktiviert.", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.__pushFixture.resolveInitial(null));
  await expect(
    page.getByText("Auf diesem Gerät aktiviert.", { exact: true }),
  ).toBeVisible();
});
