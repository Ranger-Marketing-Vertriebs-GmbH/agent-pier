import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { userAgent, userAppFixture, userChat } from "../helpers/user-app-fixture.js";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const family = userAgent({
  id: "family",
  name: "Family helper",
  shared: true,
  conversationId: "family-main",
});
const languages = {
  de: {
    greeting: "Hallo Anna",
    message: "Nachricht",
    send: "Senden",
    shared: "Geteilter Agent:",
    sharedBody: /Was er sich merkt, sein Profil \(USER\.md\) und sein Browser/,
    sharedBadge: "Geteilt",
    sharedBodyRead: /Andere, die ihn nutzen, sehen deinen Chat nicht\./,
    reads: /Der Besitzer kann deine Chats seit .+ lesen\./,
    private: "Privat: Nur du siehst diesen Chat.",
  },
  en: {
    greeting: "Hello Anna",
    message: "Message",
    send: "Send",
    shared: "Shared agent:",
    sharedBody: /what it remembers, its profile \(USER\.md\) and its browser/,
    sharedBadge: "Shared",
    sharedBodyRead: /Others who use it do not see your chat,/,
    reads: /The owner can read your chats since .+\./,
    private: "Private: only you see this chat.",
  },
};

for (const [language, copy] of Object.entries(languages)) {
  test.describe(language, () => {
    test("a user sends a message and sees the reply", async ({ page }) => {
      const state = await userAppFixture(page, { language });
      await page.goto(baseURL + "/");
      await expect(page.getByRole("heading", { name: copy.greeting })).toBeVisible();
      await page.getByRole("button", { name: /Lotta/ }).click();
      await expect(page).toHaveURL(/\/agents\/lotta\/chats\/main$/);
      await expect(page.getByText(copy.private)).toBeVisible();
      await page.getByLabel(copy.message, { exact: true }).fill("Plan my week");
      await page.getByRole("button", { name: copy.send, exact: true }).click();
      await expect(page.getByText("Reply to: Plan my week")).toBeVisible();
      expect(state.posted).toEqual([{ id: "main", text: "Plan my week" }]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      expect(state.foreign).toEqual([]);
    });

    test("a shared agent shows its notice", async ({ page }) => {
      const state = await userAppFixture(page, {
        language,
        agents: [userAgent(), family],
        chats: {
          lotta: [userChat()],
          family: [userChat({ id: "family-main" })],
        },
      });
      await page.goto(baseURL + "/agents");
      const row = page.getByRole("button", { name: /Family helper/ });
      await expect(row).toContainText(copy.sharedBadge);
      await row.click();
      await expect(page.getByText(copy.shared)).toBeVisible();
      await expect(page.getByText(copy.sharedBody)).toBeVisible();
      // Her chat is private there too, said once in the shared notice.
      await expect(page.getByText(copy.private)).toHaveCount(0);
      expect(state.foreign).toEqual([]);
    });

    test("a shared agent never calls her chat private while the owner may read it", async ({
      page,
    }) => {
      await userAppFixture(page, {
        language,
        agents: [userAgent(), family],
        chats: { lotta: [userChat()], family: [userChat({ id: "family-main" })] },
        ownerMayRead: { enabled: true, since: "2026-10-20T08:00:00.000Z" },
      });
      await page.goto(baseURL + "/agents/family/chats/family-main");
      await expect(page.getByText(copy.reads)).toBeVisible();
      await expect(page.getByText(copy.sharedBodyRead)).toBeVisible();
      await expect(page.getByText(copy.sharedBody)).toHaveCount(1);
      await expect(
        page.getByText(/Dein Chat ist privat|Your chat is private/),
      ).toHaveCount(0);
    });

    test("the opt-in notice is visible", async ({ page }) => {
      await userAppFixture(page, {
        language,
        ownerMayRead: { enabled: true, since: "2026-10-20T08:00:00.000Z" },
      });
      await page.goto(baseURL + "/agents/lotta/chats/main");
      await expect(page.getByText(copy.reads)).toBeVisible();
      await expect(page.getByText(copy.private)).toHaveCount(0);
    });

    test("no owner navigation is reachable", async ({ page }) => {
      const state = await userAppFixture(page, { language });
      await page.goto(baseURL + "/agents/lotta/chats/main");
      await expect(page.getByLabel(copy.message, { exact: true })).toBeVisible();
      await expect(page.locator(".sidebar, .mobile-header")).toHaveCount(0);
      for (const name of [
        /Sessions/,
        /Pipelines/,
        /Einstellungen$|^Settings$/,
        /Projekte|Projects/,
      ])
        await expect(page.getByRole("link", { name })).toHaveCount(0);
      // An agent she does not have is not hers to open.
      await page.goto(baseURL + "/agents/other/chats/x");
      await expect(
        page.getByText(/nicht mehr zur Verfügung|no longer available/),
      ).toBeVisible();
      expect(state.foreign).toEqual([]);
    });
  });
}
