import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { notifications, ownDeviceId } from "./notifications-fixture.js";

const shots = process.env.AGENTPIER_NOTIFICATION_SHOTS;
const now = new Date("2026-10-13T19:30:00Z");
const devices = () => [
  // Stored with the fixed name every device got before names were derived.
  {
    id: "subscription-own",
    deviceId: ownDeviceId,
    label: "Dieses Gerät",
    createdAt: "2026-10-13T19:13:52.167Z",
    lastSuccessAt: "2026-10-13T19:15:04.000Z",
  },
  {
    id: "subscription-phone",
    deviceId: "6d0f3c1a-2b4e-4c8d-9e7f-1a2b3c4d5e6f",
    label: "iPhone",
    createdAt: "2026-10-13T19:27:41.077Z",
    lastFailure: "Zustellung fehlgeschlagen. Bitte eine Testbenachrichtigung senden.",
  },
  {
    id: "subscription-legacy",
    deviceId: "7e1a4d2b-3c5f-4d9e-8f6a-2b3c4d5e6f70",
    label: "This device",
    createdAt: "2026-09-02T06:05:00.000Z",
    lastSuccessAt: "2026-10-12T18:40:00.000Z",
  },
];
const copy = {
  de: {
    switch: "Benachrichtigungen",
    active: "Auf diesem Gerät aktiviert.",
    own: "Chrome auf Mac",
    phoneOwn: "Safari auf iPhone",
    pill: "Dieses Gerät",
    unnamed: "Unbenanntes Gerät",
    ownTimes: "Angemeldet 13. Okt., 21:13 · zuletzt zugestellt 21:15",
    phoneTimes: "Angemeldet 13. Okt., 21:27",
    legacyTimes: "Angemeldet 2. Sept., 08:05 · zuletzt zugestellt 12. Okt., 20:40",
    failure:
      "Letzter Zustellfehler: Zustellung fehlgeschlagen. Bitte eine Testbenachrichtigung senden.",
    remove: (name) => `${name} abmelden`,
    confirm: "Gerät abmelden?",
    confirmButton: "Abmelden",
    cancel: "Abbrechen",
    nameField: "Gerätename",
    devices: "Angemeldete Geräte",
  },
  en: {
    switch: "Notifications",
    active: "Enabled on this device.",
    own: "Chrome on Mac",
    phoneOwn: "Safari on iPhone",
    pill: "This device",
    unnamed: "Unnamed device",
    ownTimes: "Registered Oct 13, 9:13 PM · last delivered 9:15 PM",
    phoneTimes: "Registered Oct 13, 9:27 PM",
    legacyTimes: "Registered Sep 2, 8:05 AM · last delivered Oct 12, 8:40 PM",
    failure: "Last delivery error: Delivery failed. Try a test notification.",
    remove: (name) => `Unregister ${name}`,
    confirm: "Unregister device?",
    confirmButton: "Unregister",
    cancel: "Cancel",
    nameField: "Device name",
    devices: "Registered devices",
  },
};
const viewports = {
  desktop: {
    viewport: { width: 1440, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  },
  phone: {
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  },
};

test.use({ timezoneId: "Europe/Berlin" });

async function open(page, language, size) {
  await page.setViewportSize(viewports[size].viewport);
  await page.clock.setFixedTime(now);
  await page.addInitScript(
    (language) => localStorage.setItem("agentpier-language", language),
    language,
  );
  const state = await notifications(page, {
    subscriptions: devices(),
    device: { subscribed: true, userAgent: viewports[size].userAgent },
  });
  await page.goto(baseURL + "/settings/notifications");
  return state;
}
const deviceRow = (page, name) =>
  page.locator(".notification-device", { has: page.getByText(name, { exact: true }) });

for (const language of ["de", "en"])
  for (const size of ["desktop", "phone"])
    test(`${language} ${size}: devices show readable names, times and failures and can be unregistered`, async ({
      page,
    }) => {
      const text = copy[language],
        own = size === "phone" ? text.phoneOwn : text.own;
      const state = await open(page, language, size);
      await expect(
        page.getByRole("switch", { name: text.switch, exact: true }),
      ).toBeChecked();
      await expect(page.getByText(text.active, { exact: true })).toBeVisible();
      // A legacy fixed name shows the derived name here and stays editable.
      await expect(page.getByLabel(text.nameField, { exact: true })).toHaveValue(own);
      const ownRow = deviceRow(page, own);
      await expect(ownRow.getByText(text.pill, { exact: true })).toBeVisible();
      await expect(ownRow).toContainText(text.ownTimes);
      const phone = deviceRow(page, "iPhone");
      await expect(phone).toContainText(text.phoneTimes);
      await expect(phone.locator(".notification-device-failure")).toHaveText(
        text.failure,
      );
      await expect(phone.getByText(text.pill, { exact: true })).toHaveCount(0);
      const legacy = deviceRow(page, text.unnamed);
      await expect(legacy).toContainText(text.legacyTimes);
      await expect(page.locator("body")).not.toContainText(/\d{4}-\d\d-\d\dT\d\d:/);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      if (shots && language === "en")
        await page.screenshot({
          path: `${shots}/notifications-${size}.png`,
          fullPage: true,
        });

      // Another device asks first; cancelling keeps it.
      await phone
        .getByRole("button", { name: text.remove("iPhone"), exact: true })
        .click();
      const sheet = page.getByRole("dialog", { name: text.confirm });
      await expect(sheet).toContainText("iPhone");
      if (shots && language === "en")
        await page.screenshot({ path: `${shots}/notifications-${size}-confirm.png` });
      await sheet.getByRole("button", { name: text.cancel, exact: true }).click();
      await expect(sheet).toHaveCount(0);
      expect(state.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
      await phone
        .getByRole("button", { name: text.remove("iPhone"), exact: true })
        .click();
      await sheet.getByRole("button", { name: text.confirmButton, exact: true }).click();
      await expect(deviceRow(page, "iPhone")).toHaveCount(0);
      expect(state.calls.filter((call) => call.method === "DELETE")).toEqual([
        {
          path: "/api/notifications/subscriptions/subscription-phone",
          method: "DELETE",
          body: null,
        },
      ]);
      expect(await page.evaluate(() => window.__pushFixture.unsubscribeCalls)).toBe(0);

      // This device unregisters at once, the same as turning notifications off.
      await ownRow.getByRole("button", { name: text.remove(own), exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(deviceRow(page, own)).toHaveCount(0);
      await expect(
        page.getByRole("switch", { name: text.switch, exact: true }),
      ).not.toBeChecked();
      await expect
        .poll(() => page.evaluate(() => window.__pushFixture.unsubscribeCalls))
        .toBe(1);
      expect(state.calls.at(-1).path).toBe(
        "/api/notifications/subscriptions/subscription-own",
      );
      await expect(legacy).toBeVisible();
    });

test("a new subscription is named after the browser and a rename keeps the device", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = await notifications(page, {
    device: { subscribed: false, userAgent: viewports.desktop.userAgent },
  });
  await page.goto(baseURL + "/settings/notifications");
  const name = page.getByLabel("Device name", { exact: true });
  await expect(name).toHaveValue("Chrome on Mac");
  await page.getByRole("switch", { name: "Notifications", exact: true }).click();
  await expect(page.getByText("Enabled on this device.", { exact: true })).toBeVisible();
  expect(state.calls.find((call) => call.method === "POST").body.label).toBe(
    "Chrome on Mac",
  );
  await expect(deviceRow(page, "Chrome on Mac").getByText("This device")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save name" })).toHaveCount(0);
  await name.fill("Office Mac");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(deviceRow(page, "Office Mac")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save name" })).toHaveCount(0);
  const posts = state.calls.filter((call) => call.method === "POST");
  expect(posts.at(-1).body).toMatchObject({
    deviceId: posts[0].body.deviceId,
    label: "Office Mac",
  });
  expect(state.subscriptions).toHaveLength(1);
  // A failed test is reported next to its button, not above the page.
  state.testResult = {
    sent: false,
    error:
      "Die Benachrichtigung konnte nicht zugestellt werden. Bitte Berechtigung und Abonnement dieses Geräts prüfen.",
  };
  const testButton = page.getByRole("button", { name: "Send test notification" });
  await testButton.click();
  const result = page.locator(".notification-test-row").getByRole("alert");
  await expect(result).toContainText("could not be delivered");
  await expect(testButton).toBeEnabled();
  if (shots) await page.screenshot({ path: `${shots}/notifications-test-failed.png` });
});
