import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { userAgent, userAppFixture, userChat } from "../helpers/user-app-fixture.js";

// A user's chat list (AGENTPIER-181) at 390px, through /api/me only.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const languages = {
  de: {
    chats: /Chats mit Family/,
    newChat: "Neuer Chat",
    actions: (title) => `Aktionen für ${title}`,
    archive: "Archivieren",
    delete: "Löschen",
    deleteNow: "Jetzt löschen",
    archivedList: "Archivierte Chats",
    readOnly: /Archivierte Chats sind nur lesbar/,
    restore: "Wiederherstellen",
    message: "Nachricht",
    deleted: "Dieser Chat wurde gelöscht.",
    toMain: "Hauptchat öffnen",
  },
  en: {
    chats: /Chats with Family/,
    newChat: "New chat",
    actions: (title) => `Actions for ${title}`,
    archive: "Archive",
    delete: "Delete",
    deleteNow: "Delete now",
    archivedList: "Archived chats",
    readOnly: /Archived chats are read-only/,
    restore: "Restore",
    message: "Message",
    deleted: "This chat was deleted.",
    toMain: "Open main chat",
  },
};

const family = userAgent({
  id: "family",
  name: "Family",
  shared: true,
  conversationId: "anna-main",
});
const row = (page, title) =>
  page.locator(".agent-chat-list .list-row-main", { hasText: title });

for (const [language, copy] of Object.entries(languages))
  test.describe(language, () => {
    test("a user sees only her own chats on a shared agent", async ({ page }) => {
      // The server lists only her chats; Ben's chat with the same agent never arrives.
      const state = await userAppFixture(page, {
        language,
        agents: [family],
        chats: {
          family: [
            userChat({ id: "anna-main", title: "Shopping" }),
            userChat({ id: "anna-2", main: false, title: "Holidays" }),
          ],
        },
        messages: { "anna-main": [{ id: "1", role: "assistant", text: "Milk added." }] },
      });
      await page.goto(baseURL + "/agents/family/chats/anna-main");
      await expect(page.getByText("Milk added.")).toBeVisible();
      await page.getByRole("button", { name: copy.chats }).click();
      await expect(row(page, "Shopping")).toBeVisible();
      await expect(row(page, "Holidays")).toBeVisible();
      await expect(page.locator(".agent-chat-list .list-row-main")).toHaveCount(2);
      await row(page, "Holidays").click();
      await expect(page).toHaveURL(/\/agents\/family\/chats\/anna-2$/);
      expect(state.foreign).toEqual([]);
    });

    test("typing /new opens the chat it started", async ({ page }) => {
      await userAppFixture(page, {
        language,
        agents: [family],
        chats: { family: [userChat({ id: "anna-main", title: "Shopping" })] },
        messages: { "anna-main": [{ id: "1", role: "assistant", text: "Milk added." }] },
      });
      await page.goto(baseURL + "/agents/family/chats/anna-main");
      await expect(page.getByText("Milk added.")).toBeVisible();
      await page.getByLabel(copy.message, { exact: true }).fill("/new");
      await page.getByRole("button", { name: /Senden|Send/ }).click();
      await expect(page).toHaveURL(/\/agents\/family\/chats\/chat-\d+$/);
      await expect(page.getByText("Milk added.")).toHaveCount(0);
      await expect(page.getByText(copy.deleted)).toHaveCount(0);
    });

    test("she starts, archives, restores and deletes her chats", async ({ page }) => {
      const state = await userAppFixture(page, {
        language,
        agents: [family],
        chats: { family: [userChat({ id: "anna-main", title: "Shopping" })] },
      });
      await page.goto(baseURL + "/agents/family/chats/anna-main");
      await page.getByRole("button", { name: copy.chats }).click();
      await page.getByRole("button", { name: copy.newChat, exact: true }).click();
      await expect(page).toHaveURL(/\/agents\/family\/chats\/chat-\d+$/);
      const id = new URL(page.url()).pathname.split("/").pop();
      state.chats.family.find((c) => c.id === id).title = "Party";
      await page.getByLabel(copy.message, { exact: true }).fill("Plan the party");
      await page.getByRole("button", { name: /Senden|Send/ }).click();
      await expect(page.getByText("Reply to: Plan the party")).toBeVisible();
      await page.getByRole("button", { name: copy.chats }).click();
      await page.getByRole("button", { name: copy.actions("Party") }).click();
      await page.getByRole("button", { name: copy.archive, exact: true }).click();
      // The chat she is in is archived now: read-only, with Restore.
      await expect(page.getByText(copy.readOnly)).toBeVisible();
      await expect(page.getByLabel(copy.message, { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: copy.restore, exact: true }).click();
      await expect(page.getByLabel(copy.message, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: copy.chats }).click();
      await page.getByRole("button", { name: copy.actions("Party") }).click();
      await page.getByRole("button", { name: copy.delete, exact: true }).click();
      await page.getByRole("button", { name: copy.deleteNow, exact: true }).click();
      await expect(page.getByText(copy.deleted)).toBeVisible();
      await page.getByRole("button", { name: copy.toMain }).click();
      await expect(page).toHaveURL(/\/agents\/family\/chats\/anna-main$/);
      expect(state.chats.family.map((c) => c.id)).toEqual(["anna-main"]);
      expect(state.foreign).toEqual([]);
    });
  });
