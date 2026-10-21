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
