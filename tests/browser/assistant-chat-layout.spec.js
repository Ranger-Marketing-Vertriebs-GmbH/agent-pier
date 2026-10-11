import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

const chat = baseURL + "/agents/home/chats/dinner";
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test.describe("agent chat header", () => {
  test("phone shows one 56px bar instead of the app header", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const header = page.locator(".assistant-header");
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("Home assistant");
    await expect(page.locator(".mobile-header")).toBeHidden();
    await expect(page.locator(".assistant-breadcrumb, .assistant-view-tabs")).toHaveCount(
      0,
    );
    const status = header.locator(".assistant-header-status");
    await expect(status).toHaveClass(/\bready\b/);
    await expect(status).toContainText("Ready");
    await expect(status).toContainText("· openai/gpt-4.1-mini");
    await expect(status.locator(".assistant-header-dot")).toHaveCSS(
      "background-color",
      "rgb(125, 214, 165)",
    );
    expect(Math.round((await header.boundingBox()).height)).toBe(56);
    await header.getByRole("button", { name: "Agent settings", exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/home\/settings$/);
    await expect(page.locator(".assistant-header-sub")).toHaveText("Settings");
    await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner$/);
  });

  test("header menu opens the drawer and Escape returns focus to it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const menu = page
      .locator(".assistant-header")
      .getByRole("button", { name: "Open navigation", exact: true });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(page.locator(".sidebar")).toHaveClass(/\bopen\b/);
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).not.toHaveClass(/\bopen\b/);
    await expect(menu).toBeFocused();
  });

  test("settings without a connection still reach the drawer and the agent list", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, {
      models: [{ id: "other", name: "Other", available: true }],
    });
    await page.goto(baseURL + "/agents/home/settings");
    await expect(page.locator(".assistant-header-status")).toHaveText(
      "Provider connection missing",
    );
    await expect(page.locator(".assistant-notice").first()).toContainText(
      "provider connection was deleted",
    );
    await page
      .locator(".assistant-header")
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await expect(page.locator(".sidebar")).toHaveClass(/\bopen\b/);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
    await expect(page).toHaveURL(/\/agents$/);
  });

  test("a collapsed desktop sidebar does not cover the header", async ({ page }) => {
    await chatFixture(page);
    await page.goto(chat);
    await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
    const [float, avatar, header] = await Promise.all([
      page.locator(".sidebar-float").boundingBox(),
      page.locator(".assistant-header .assistant-avatar").boundingBox(),
      page.locator(".assistant-header").boundingBox(),
    ]);
    expect(avatar.x).toBeGreaterThanOrEqual(float.x + float.width);
    expect(header.y).toBe(0);
    expect(Math.round(header.height)).toBe(68);
  });

  for (const language of ["de", "en"])
    test(`320px phone keeps long header copy inside the bar (${language})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await chatFixture(page, {
        language,
        assistants: [
          chatAssistant({
            name: "Chief of Staff with a long agent name",
            model: {
              connectionId: "router",
              modelId: "anthropic/claude-sonnet-4.5-long",
            },
          }),
        ],
        activity: {
          home: {
            state: "waiting",
            reason: "approval",
            label: "teamActive.awaiting",
            pendingApprovals: 1,
            team: "awaiting",
          },
        },
      });
      await page.goto(chat);
      const status = page.locator(".assistant-header-status");
      await expect(status).toContainText(
        language === "en" ? "Team awaiting approval" : "Team wartet auf Freigabe",
      );
      const [label, gear] = await Promise.all([
        status.boundingBox(),
        page.locator(".assistant-header-settings").boundingBox(),
      ]);
      expect(label.x + label.width).toBeLessThanOrEqual(gear.x + 1);
      expect(gear.x + gear.width).toBeLessThanOrEqual(320);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
});

export { emit };
