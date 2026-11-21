import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { notifications } from "./notifications-fixture.js";
test("notifications require explicit permission and successful persistence before showing enabled", async ({
  page,
}) => {
  const state = await notifications(page);
  state.failSave = true;
  await page.goto(baseURL + "/settings/notifications");
  // App & Benachrichtigungen is a settings tab at this address.
  await expect(
    page.getByRole("tab", { name: "App & Benachrichtigungen", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => window.__pushFixture.permissionCalls)).toBe(0);
  await page.getByRole("switch", { name: "Benachrichtigungen", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture persistence failed");
  await expect(
    page.getByText("Auf diesem Gerät aktiviert.", { exact: true }),
  ).toHaveCount(0);
  state.failSave = false;
  await page.getByRole("switch", { name: "Benachrichtigungen", exact: true }).click();
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
  await page.getByRole("switch", { name: "Benachrichtigungen", exact: true }).click();
  await expect(
    page.getByText("Auf diesem Gerät aktiviert.", { exact: true }),
  ).toBeVisible();
  state.failDelete = true;
  await page.getByRole("switch", { name: "Benachrichtigungen", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture delete failed");
  expect(await page.evaluate(() => window.__pushFixture.unsubscribeCalls)).toBe(0);
  state.failDelete = false;
  await page.evaluate(() => {
    window.__pushFixture.failUnsubscribe = true;
  });
  await page.getByRole("switch", { name: "Benachrichtigungen", exact: true }).click();
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
  // The server entry is gone, so the switch is off; the retry finishes the browser side.
  await expect(
    page.getByRole("switch", { name: "Benachrichtigungen", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__pushFixture.unsubscribeCalls))
    .toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("an initial subscription read cannot overwrite a later successful opt-in", async ({
  page,
}) => {
  await notifications(page, { deferInitialRead: true });
  await page.goto(baseURL + "/settings/notifications");
  await page.waitForFunction(() => Boolean(window.__pushFixture.resolveInitial));
  await page.getByRole("switch", { name: "Benachrichtigungen", exact: true }).click();
  await expect(
    page.getByText("Auf diesem Gerät aktiviert.", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.__pushFixture.resolveInitial(null));
  await expect(
    page.getByText("Auf diesem Gerät aktiviert.", { exact: true }),
  ).toBeVisible();
});

// AGENTPIER-456: the browser's refusal shows in the app's language, not the browser's.
for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["phone", { width: 390, height: 844 }],
])
  test(`a refused push registration is explained in the app's words (${label})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
    await notifications(page);
    await page.goto(baseURL + "/settings/notifications");
    await page.evaluate(() => (window.__pushFixture.refuseSubscribe = "AbortError"));
    await page.getByRole("switch", { name: "Notifications", exact: true }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(
      "The browser did not register this device for notifications.",
    );
    await expect(alert).not.toContainText("Registration failed");
    await page.evaluate(() => (window.__pushFixture.refuseSubscribe = "NotAllowedError"));
    await page.getByRole("switch", { name: "Notifications", exact: true }).click();
    await expect(alert).toContainText("Notifications are blocked in the browser.");
  });
