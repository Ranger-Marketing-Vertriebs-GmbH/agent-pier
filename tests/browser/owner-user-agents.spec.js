import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { home, setupAssistantSettings } from "../helpers/assistant-settings-browser.js";

// Agents of users in the owner's agent pages: the hard lock explained, folders only,
// no user chat in his views, and his own chat with a shared agent.
const anna = { id: "u-1", username: "anna", displayName: "Anna", disabled: false };
const shared = (extra = {}) =>
  home({
    userAccess: {
      mode: "shared",
      members: [{ userId: "u-1", level: "chat" }],
      released: [],
    },
    ...extra,
  });
const languages = {
  de: {
    locked: /Für Agenten von Benutzern gesperrt: Sie können keine Programme/,
    shell: "Shell",
    projects: "Projekte",
    read: "Lesen",
    save: "Speichern",
    openMyChat: "Meinen Chat öffnen",
    ofUsers: "Agenten von Benutzern",
    chats: /Chats mit Home/,
  },
  en: {
    locked: /Locked for agents of users: they cannot run programs/,
    shell: "Shell",
    projects: "Projects",
    read: "Read",
    save: "Save",
    openMyChat: "Open my chat",
    ofUsers: "Agents of users",
    chats: /Chats with Home/,
  },
};

async function users(page) {
  await page.route(/\/api\/users$/, (route) => route.fulfill({ json: [anna] }));
}

for (const [language, copy] of Object.entries(languages))
  test.describe(language, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("locked groups explain why", async ({ page }) => {
      await setupAssistantSettings(page, { language, assistants: [shared()] });
      await users(page);
      await page.goto(baseURL + "/agents/home/settings?tab=capabilities");
      await expect(page.getByText(copy.locked)).toBeVisible();
      await expect(page.locator("#agent-shell, [data-shell-group]")).toHaveCount(0);
      await page.goto(baseURL + "/agents/home/settings?tab=work");
      await expect(page.getByText(copy.locked)).toBeVisible();
      await expect(page.getByText("GitHub", { exact: false })).toHaveCount(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
    });

    test("owner assigns a project folder read-only", async ({ page }) => {
      const state = await setupAssistantSettings(page, {
        language,
        assistants: [shared()],
        access: { revision: 1, projectIds: [], projectFiles: {} },
        catalog: {
          projects: [{ id: "p1", name: "Household", path: "/home/household" }],
          pipelines: [],
        },
      });
      await users(page);
      await page.goto(baseURL + "/agents/home/settings?tab=work&page=projects");
      await page.getByRole("checkbox", { name: /Household/ }).check();
      await expect(
        page.getByRole("radio", { name: copy.read, exact: true }),
      ).toBeChecked();
      await expect(page.getByRole("radio")).toHaveCount(2);
      await page.getByRole("button", { name: copy.save, exact: true }).click();
      await expect.poll(() => state.work.length).toBe(1);
      expect(state.work[0].access.projectFiles).toEqual({ p1: "read" });
      expect(state.work[0].access.projectIds).toEqual([]);
    });

    test("owner opens his own chat with a shared agent", async ({ page }) => {
      const state = await setupAssistantSettings(page, {
        language,
        assistants: [shared()],
        // Anna's chat with it never opens for him.
        conversations: [{ id: "annas", assistantId: "home", userId: "u-1", main: true }],
      });
      await users(page);
      await page.goto(baseURL + "/agents");
      await expect(page.getByRole("heading", { name: copy.ofUsers })).toBeVisible();
      await page.getByRole("button", { name: copy.openMyChat }).click();
      await expect(page).not.toHaveURL(/chats\/annas/);
      expect(state.opened).toBe(1);
    });
  });

test.describe("sidebar", () => {
  test("owner sees no user chat in the sidebar", async ({ page }) => {
    const state = await setupAssistantSettings(page, {
      assistants: [home({ id: "mine", name: "Mine" }), shared({ name: "Family" })],
      conversations: [
        { id: "annas", assistantId: "home", userId: "u-1", main: true },
        { id: "own", assistantId: "mine", main: true },
      ],
    });
    await users(page);
    await page.goto(baseURL + "/agents");
    await expect(
      page.locator(".assistant-sidebar-section", { hasText: "Agents of users" }),
    ).toBeVisible();
    await page.locator(".assistant-sidebar-item", { hasText: "Family" }).click();
    // His own chat opens (a new one), never Anna's.
    await expect(page).not.toHaveURL(/chats\/annas/);
    expect(state.opened).toBe(1);
  });

  test("owner's chat list shows no user chats without opt-in", async ({ page }) => {
    await setupAssistantSettings(page, {
      assistants: [shared()],
      conversations: [{ id: "mine", assistantId: "home", main: true, title: "Mine" }],
    });
    await users(page);
    await page.route(/\/api\/assistants\/home\/chats/, (route) =>
      route.fulfill({
        json: [
          { id: "mine", title: "Mine", main: true, archivedAt: null, userId: null },
          { id: "annas", title: "Anna's", main: true, archivedAt: null, userId: "u-1" },
        ],
      }),
    );
    await page.goto(baseURL + "/agents/home/chats/mine");
    await page.getByRole("button", { name: /Chats with Home/ }).click();
    const list = page.locator(".agent-chat-list .list-row-main");
    await expect(list).toHaveCount(1);
    await expect(list).toContainText("Mine");
  });
});
