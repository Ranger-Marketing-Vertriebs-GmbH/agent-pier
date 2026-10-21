import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { installPushStack, userAppFixture } from "../helpers/user-app-fixture.js";

// A user's account page at 390px: password, privacy and her devices, over /api/me.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const languages = {
  de: {
    change: "Passwort ändern",
    current: "Aktuelles Passwort",
    next: "Neues Passwort",
    changed: "Passwort geändert. Deine anderen Geräte sind abgemeldet.",
    optIn: "Besitzer darf Chats lesen",
    off: "Aus",
    on: /^An seit /,
    notifications: "Benachrichtigungen",
    signOut: "Abmelden",
    deviceSettings: /^Benachrichtigungseinstellungen für /,
    sheet: /^Benachrichtigungen auf /,
    hers: ["Freigabe für einen Agenten", "Agent meldet sich", "Ergebnis einer Routine"],
    owners: [/Session/, /Pipeline/, /CLI/, /GitHub/],
  },
  en: {
    change: "Change password",
    current: "Current password",
    next: "New password",
    changed: "Password changed. Your other devices are signed out.",
    optIn: "Owner may read chats",
    off: "Off",
    on: /^On since /,
    notifications: "Notifications",
    signOut: "Sign out",
    deviceSettings: /^Notification settings for /,
    sheet: /^Notifications on /,
    hers: ["Agent approval", "Agent check-in", "Routine result"],
    owners: [/Session/, /Pipeline/, /CLI/, /GitHub/],
  },
};

for (const [language, copy] of Object.entries(languages))
  test.describe(language, () => {
    test("a user changes her password and stays signed in here", async ({ page }) => {
      const state = await userAppFixture(page, { language });
      await page.goto(baseURL + "/account");
      await expect(page.getByText("anna", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: copy.change }).click();
      const dialog = page.getByRole("dialog", { name: copy.change });
      await dialog.getByLabel(copy.current).fill("wrong-password-1");
      await dialog.getByLabel(copy.next).fill("a-brand-new-password");
      await dialog.getByRole("button", { name: copy.change }).click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await dialog.getByLabel(copy.current).fill("current-password-1");
      await dialog.getByRole("button", { name: copy.change }).click();
      await expect(page.getByText(copy.changed)).toBeVisible();
      expect(state.password).toBe("a-brand-new-password");
      // Still signed in: her app stays, nothing asked her to sign in again.
      await expect(page.getByRole("button", { name: copy.signOut })).toBeVisible();
      expect(state.signedOut).toBe(false);
      expect(state.foreign).toEqual([]);
    });

    test("a user enables notifications for this device", async ({ page }) => {
      await installPushStack(page);
      const state = await userAppFixture(page, { language });
      await page.goto(baseURL + "/account");
      await page.getByRole("switch", { name: copy.notifications }).click();
      await expect(page.getByRole("switch", { name: copy.notifications })).toBeChecked();
      expect(state.notificationCalls.map((c) => `${c.method} ${c.path}`)).toContain(
        "POST /api/me/notifications/subscriptions",
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      expect(state.foreign).toEqual([]);
      // Signing out takes this device away from her: the next person here gets no notices.
      const registered = state.notificationCalls.find((c) => c.method === "POST");
      await page.getByRole("button", { name: copy.signOut, exact: true }).click();
      await expect.poll(() => state.logoutBody?.deviceId).toBe(registered.body.deviceId);
      await expect.poll(() => page.evaluate(() => window.pushUnsubscribed)).toBe(true);
    });

    test("her device's settings offer only her agents' notices", async ({ page }) => {
      await installPushStack(page);
      await userAppFixture(page, { language });
      await page.goto(baseURL + "/account");
      await page.getByRole("switch", { name: copy.notifications }).click();
      await page.getByRole("button", { name: copy.deviceSettings }).click();
      const sheet = page.getByRole("dialog", { name: copy.sheet });
      for (const name of copy.hers)
        await expect(sheet.getByRole("checkbox", { name, exact: true })).toBeVisible();
      for (const name of copy.owners)
        await expect(sheet.getByRole("checkbox", { name })).toHaveCount(0);
      await expect(sheet.getByText(/GitHub/)).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
    });

    test("the privacy row reflects the opt-in", async ({ page }) => {
      await userAppFixture(page, { language });
      await page.goto(baseURL + "/account");
      const row = page.locator(".list-row", { hasText: copy.optIn });
      await expect(row.locator(".list-row-value")).toHaveText(copy.off);
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await userAppFixture(page, {
        language,
        ownerMayRead: { enabled: true, since: "2026-10-20T08:00:00.000Z" },
      });
      await page.reload();
      await expect(row.locator(".list-row-value")).toHaveText(copy.on);
    });
  });
