import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { notifications, ownDeviceId } from "./notifications-fixture.js";

const chrome =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const english = (page) =>
  page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
const posts = (state, suffix) =>
  state.calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));

test.use({ timezoneId: "Europe/Berlin" });

test("the start page says a device was lost, opens the settings and hides for the session", async ({
  page,
}) => {
  await english(page);
  const state = await notifications(page);
  state.health = {
    devices: 0,
    lost: true,
    failing: false,
    removed: { label: "Pixel", reason: "expired", at: "2026-10-29T08:15:00Z" },
  };
  await page.goto(baseURL + "/");
  const notice = page.locator(".push-health-notice");
  await expect(notice).toContainText("Notifications reach no device");
  await expect(notice).toContainText(
    "“Pixel” stopped receiving notifications on Oct 29, 9:15 AM because the browser's push service no longer accepts it.",
  );
  await notice
    .getByRole("button", { name: "Notification settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/notifications$/);
  await page.goto(baseURL + "/");
  await page
    .locator(".push-health-notice")
    .getByRole("button", { name: "Hide", exact: true })
    .click();
  await expect(page.locator(".push-health-notice")).toHaveCount(0);
  // The same browser session keeps it hidden; the next session shows it again.
  await page.reload();
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.locator(".push-health-notice")).toHaveCount(0);
});

test("German: the inbox warns when the last delivery failed on every device", async ({
  page,
}) => {
  const state = await notifications(page);
  state.health = { devices: 2, lost: false, failing: true };
  await page.goto(baseURL + "/inbox");
  const notice = page.locator(".push-health-notice");
  await expect(notice).toContainText("Benachrichtigungen kommen nicht an");
  await expect(notice).toContainText(
    "Die letzte Benachrichtigung konnte an keines deiner Geräte zugestellt werden.",
  );
  await expect(
    notice.getByRole("button", { name: "Benachrichtigungseinstellungen", exact: true }),
  ).toBeVisible();
});

test("no notice while a device receives notifications", async ({ page }) => {
  await english(page);
  const state = await notifications(page);
  state.health = { devices: 1, lost: false, failing: false };
  await page.goto(baseURL + "/inbox");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.locator(".push-health-notice")).toHaveCount(0);
});

test("a browser subscription the server forgot registers again on load", async ({
  page,
}) => {
  await english(page);
  const state = await notifications(page, {
    device: { subscribed: true, userAgent: chrome },
  });
  await page.goto(baseURL + "/");
  await expect.poll(() => posts(state, "/subscriptions").length).toBe(1);
  expect(posts(state, "/subscriptions")[0].body).toMatchObject({
    deviceId: ownDeviceId,
    label: "Chrome on Mac",
    subscription: { endpoint: "https://push.example.invalid/device" },
  });
  expect(posts(state, "/renew")).toHaveLength(0);
  expect(await page.evaluate(() => window.__pushFixture.permissionCalls)).toBe(0);
});

test("a known device renews its subscription and keeps its name", async ({ page }) => {
  await english(page);
  const state = await notifications(page, {
    subscriptions: [
      {
        id: "subscription-own",
        deviceId: ownDeviceId,
        label: "Office Mac",
        createdAt: "2026-10-13T19:13:52.167Z",
      },
    ],
    device: { subscribed: true, userAgent: chrome },
  });
  await page.goto(baseURL + "/");
  await expect.poll(() => posts(state, "/renew").length).toBe(1);
  expect(posts(state, "/renew")[0].body.deviceId).toBe(ownDeviceId);
  expect(posts(state, "/subscriptions")).toHaveLength(0);
});

test("another person's subscription in this browser is never taken over", async ({
  page,
}) => {
  await english(page);
  await page.addInitScript(() =>
    localStorage.setItem("agentpier.notification-person", "user:someone-else"),
  );
  const state = await notifications(page, {
    device: { subscribed: true, userAgent: chrome },
  });
  await page.goto(baseURL + "/");
  await expect(page.getByRole("heading").first()).toBeVisible();
  // The start page's own status read shows the reconciliation has finished.
  await expect
    .poll(() => state.calls.filter((call) => call.method === "GET").length)
    .toBeGreaterThan(1);
  expect(posts(state, "/subscriptions")).toHaveLength(0);
  expect(posts(state, "/renew")).toHaveLength(0);
});

test("the device list shows when the last delivery failed and why", async ({ page }) => {
  await english(page);
  await notifications(page, {
    subscriptions: [
      {
        id: "subscription-phone",
        deviceId: "6d0f3c1a-2b4e-4c8d-9e7f-1a2b3c4d5e6f",
        label: "Pixel",
        createdAt: "2026-10-13T19:27:41.077Z",
        lastFailure: "Zustellung fehlgeschlagen. Bitte eine Testbenachrichtigung senden.",
        lastDelivery: {
          at: "2026-10-29T08:15:00Z",
          status: "failed",
          kind: "question",
          statusCode: 500,
          failure: "Zustellung fehlgeschlagen. Bitte eine Testbenachrichtigung senden.",
        },
      },
    ],
  });
  await page.goto(baseURL + "/settings/notifications");
  await expect(page.locator(".notification-device-failure")).toHaveText(
    "Last delivery failed (Oct 29, 9:15 AM): Delivery failed. Try a test notification.",
  );
});
