import { test, expect } from "@playwright/test";
import { fixture } from "./ssh-fixture.js";

test.use({ locale: "en-GB" });

async function agentsOn(page) {
  await page.route(/\/api\/assistant/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/assistant-feature")
      return route.fulfill({ json: { enabled: true, error: null } });
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [],
          conversations: [],
          models: [{ id: "router", name: "OpenRouter", available: true }],
          policies: {},
          teamSettings: { revision: 0, hostMaxConcurrent: 8 },
        },
      });
    return route.fallback();
  });
}

const sidebarNew = (page) => page.locator(".sidebar .sidebar-launch").getByRole("button");
const menu = (page) => page.getByRole("menu", { name: "New" });

async function open(page, narrow) {
  await page.goto("/");
  if (narrow) await page.getByRole("button", { name: "Open navigation" }).click();
}

for (const width of [1280, 390]) {
  test.describe(`${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
    });

    test("the orange button offers Session and Agent in a menu", async ({ page }) => {
      await fixture(page);
      await agentsOn(page);
      await open(page, width < 700);
      const button = sidebarNew(page);
      await expect(button).toHaveText(/New/);
      await expect(button).toHaveAttribute("aria-haspopup", "menu");
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(menu(page).getByRole("menuitem")).toHaveText(["Session", "Agent"]);
      await expect(menu(page).getByRole("menuitem", { name: "Session" })).toBeFocused();
      for (const item of await menu(page).getByRole("menuitem").all())
        expect((await item.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await page.keyboard.press("ArrowDown");
      await expect(menu(page).getByRole("menuitem", { name: "Agent" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(menu(page).getByRole("menuitem", { name: "Session" })).toBeFocused();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`new-menu-${width}.png`),
      });
    });

    test("Session opens the launch dialog", async ({ page }) => {
      await fixture(page);
      await agentsOn(page);
      await open(page, width < 700);
      await sidebarNew(page).click();
      await menu(page).getByRole("menuitem", { name: "Session" }).click();
      await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible();
    });

    test("Agent opens the create-agent flow", async ({ page }) => {
      await fixture(page);
      await agentsOn(page);
      await open(page, width < 700);
      await sidebarNew(page).click();
      await menu(page).getByRole("menuitem", { name: "Agent" }).click();
      await expect(page).toHaveURL(/\/agents\?new=1$/);
      await expect(
        page.getByRole("heading", { name: "New agent", level: 1 }),
      ).toBeVisible();
    });

    test("Escape closes the menu and returns focus to the button", async ({ page }) => {
      await fixture(page);
      await agentsOn(page);
      await open(page, width < 700);
      await sidebarNew(page).click();
      await expect(menu(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu(page)).toHaveCount(0);
      await expect(sidebarNew(page)).toBeFocused();
      await expect(sidebarNew(page)).toHaveAttribute("aria-expanded", "false");
    });

    test("Agent is not offered while agents are off", async ({ page }) => {
      await fixture(page);
      await open(page, width < 700);
      await sidebarNew(page).click();
      await expect(menu(page).getByRole("menuitem")).toHaveText(["Session"]);
    });
  });
}

const inViewport = async (page, locator) => {
  const box = await locator.boundingBox();
  const size = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
};

test.describe("the small + buttons", () => {
  test("the phone header + offers the same choice and the menu fits at 390px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page);
    await agentsOn(page);
    await page.goto("/");
    const plus = page.locator(".mobile-header").getByRole("button", { name: "New" });
    await expect(plus).toHaveAttribute("aria-haspopup", "menu");
    await plus.click();
    await expect(menu(page).getByRole("menuitem")).toHaveText(["Session", "Agent"]);
    await expect(menu(page).getByRole("menuitem", { name: "Session" })).toBeFocused();
    await inViewport(page, menu(page));
    for (const item of await menu(page).getByRole("menuitem").all())
      expect((await item.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: test.info().outputPath("new-menu-header-390.png") });
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(plus).toBeFocused();
    await plus.click();
    await menu(page).getByRole("menuitem", { name: "Session" }).click();
    await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible();
  });

  test("the phone header + hides Agent while agents are off", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page);
    await page.goto("/");
    await page.locator(".mobile-header").getByRole("button", { name: "New" }).click();
    await expect(menu(page).getByRole("menuitem")).toHaveText(["Session"]);
  });

  test("the + of a collapsed sidebar offers the choice below the floating bar", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await fixture(page);
    await agentsOn(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Collapse navigation" }).click();
    const plus = page.locator(".sidebar-float").getByRole("button", { name: "New" });
    await plus.click();
    await expect(menu(page).getByRole("menuitem")).toHaveText(["Session", "Agent"]);
    await inViewport(page, menu(page));
    await page.screenshot({ path: test.info().outputPath("new-menu-collapsed.png") });
    await menu(page).getByRole("menuitem", { name: "Agent" }).click();
    await expect(page).toHaveURL(/\/agents\?new=1$/);
    await expect(
      page.getByRole("heading", { name: "New agent", level: 1 }),
    ).toBeVisible();
  });
});
