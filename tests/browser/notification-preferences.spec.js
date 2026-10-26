import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { notifications, ownDeviceId } from "./notifications-fixture.js";

const shots = process.env.AGENTPIER_NOTIFICATION_SHOTS;
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const viewports = {
  desktop: { width: 1440, height: 1000 },
  phone: { width: 390, height: 844 },
};

test.use({ timezoneId: "Europe/Berlin" });

async function open(page, size, { subscribed = true } = {}) {
  await page.setViewportSize(viewports[size]);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = await notifications(page, {
    subscriptions: subscribed
      ? [
          {
            id: "subscription-own",
            deviceId: ownDeviceId,
            label: "Office Mac",
            createdAt: "2026-10-13T19:13:52.167Z",
          },
        ]
      : [],
    device: { subscribed, userAgent },
  });
  await page.goto(baseURL + "/settings/notifications");
  return state;
}

const noHorizontalScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const size of ["desktop", "phone"])
  test(`${size}: a device's detail level, events, grouping and quiet hours are saved together`, async ({
    page,
  }) => {
    const state = await open(page, size);
    await page
      .getByRole("button", { name: "Notification settings for Office Mac", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Notifications on Office Mac" });
    await expect(dialog).toBeVisible();
    // New and older devices start at the event type only.
    await expect(dialog.getByRole("radio", { name: "Event type only" })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "Pipeline failed" })).toBeChecked();
    await expect(
      dialog.getByRole("checkbox", { name: "Pipeline completed" }),
    ).not.toBeChecked();
    await expect(
      dialog.getByRole("checkbox", { name: "Also what Telegram delivered" }),
    ).not.toBeChecked();
    await dialog.getByRole("radio", { name: "With preview" }).check();
    await dialog.getByRole("checkbox", { name: "Session ended" }).uncheck();
    await dialog.getByRole("checkbox", { name: "Pipeline completed" }).check();
    // A hook's throttle notice has its own switch beside routine results.
    await dialog.getByRole("checkbox", { name: "Hook limit reached" }).setChecked(false);
    await dialog
      .getByRole("switch", { name: "Group by session, agent or run" })
      .uncheck();
    await expect(dialog.getByLabel("From", { exact: true })).toHaveCount(0);
    await dialog.getByRole("switch", { name: "Quiet hours" }).check();
    await expect(dialog).toContainText("Times in Europe/Berlin.");
    await dialog.getByLabel("From", { exact: true }).fill("21:30");
    await dialog.getByLabel("To", { exact: true }).fill("06:45");
    await dialog
      .getByRole("switch", { name: "Let questions and approvals through" })
      .check();
    expect(await noHorizontalScroll(page)).toBe(true);
    if (shots)
      await page.screenshot({ path: `${shots}/notification-settings-${size}.png` });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const put = state.calls.find((call) => call.method === "PUT");
    expect(put.path).toBe(
      "/api/notifications/subscriptions/subscription-own/preferences",
    );
    expect(put.body).toMatchObject({
      level: "preview",
      grouping: false,
      timeZone: "Europe/Berlin",
      quiet: { enabled: true, from: "21:30", to: "06:45", blockingThrough: true },
    });
    expect(put.body.events).toMatchObject({
      "session-ended": false,
      "pipeline-completed": true,
      "pipeline-failed": true,
      "agent-hook-throttled": false,
    });
    // Opening again shows what was saved; Cancel changes nothing.
    await page
      .getByRole("button", { name: "Notification settings for Office Mac", exact: true })
      .click();
    await expect(dialog.getByRole("radio", { name: "With preview" })).toBeChecked();
    await dialog.getByRole("radio", { name: "With names" }).check();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(state.subscriptions[0].preferences.level).toBe("preview");
  });

test("enabling a new device offers names on its lock screen without forcing them", async ({
  page,
}) => {
  const state = await open(page, "phone", { subscribed: false });
  await page.getByRole("switch", { name: "Notifications", exact: true }).click();
  const offer = page.getByRole("group", { name: "Show names in notifications?" });
  await expect(offer).toBeVisible();
  expect(state.subscriptions[0].preferences.level).toBe("type");
  expect(await noHorizontalScroll(page)).toBe(true);
  await offer.getByRole("button", { name: "Show names", exact: true }).click();
  await expect(offer).toHaveCount(0);
  expect(state.calls.find((call) => call.method === "PUT").body).toMatchObject({
    level: "label",
  });
  expect(state.subscriptions[0].preferences.level).toBe("label");
});

test("the offer can be dismissed and leaves the event type only", async ({ page }) => {
  const state = await open(page, "desktop", { subscribed: false });
  await page.getByRole("switch", { name: "Notifications", exact: true }).click();
  const offer = page.getByRole("group", { name: "Show names in notifications?" });
  await offer.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(offer).toHaveCount(0);
  expect(state.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  expect(state.subscriptions[0].preferences.level).toBe("type");
});
