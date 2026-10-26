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

const menu = (page) => page.getByRole("menu", { name: "New" });
// The compact "+ New" of whichever bar is on screen: the phone header at 390px, the
// floating bar of the collapsed sidebar at 1280px.
const compactNew = (page, narrow) =>
  page
    .locator(narrow ? ".mobile-header" : ".sidebar-float")
    .getByRole("button", { name: "New", exact: true });

async function open(page, narrow) {
  await page.goto("/");
  if (!narrow) await page.getByRole("button", { name: "Collapse navigation" }).click();
}

test.describe("the expanded sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
  });
  const sidebar = (page) => page.locator(".sidebar");
  const sessionsPlus = (page) =>
    page
      .locator(".sessions-group .sidebar-group-actions")
      .getByRole("button", { name: "New session", exact: true });
  const agentsPlus = (page) =>
    page
      .locator(".assistant-chats-group .sidebar-group-actions")
      .getByRole("link", { name: "New agent", exact: true });

  test("has no New menu; the Sessions + opens the launch dialog", async ({ page }) => {
    await fixture(page);
    await agentsOn(page);
    await page.goto("/");
    await expect(sessionsPlus(page)).toBeVisible();
    await expect(
      sidebar(page).getByRole("button", { name: "New", exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar(page).locator("[aria-haspopup=menu]").filter({ hasText: "New" }),
    ).toHaveCount(0);
    await sessionsPlus(page).click();
    await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible();
  });

  test("without agents yet, the Agents group still offers its +", async ({ page }) => {
    await fixture(page);
    await agentsOn(page);
    await page.goto("/");
    const group = page.locator(".assistant-chats-group");
    await expect(group).toBeVisible();
    await expect(group.locator(".sidebar-group-count")).toHaveText("0");
    await expect(group).toContainText("Create your first agent to start a conversation.");
    await agentsPlus(page).click();
    await expect(page).toHaveURL(/\/agents\?new=1$/);
    await expect(
      page.getByRole("heading", { name: "New agent", level: 1 }),
    ).toBeVisible();
  });

  test("with agents off, the Sessions + still creates a session", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await expect(sessionsPlus(page)).toBeVisible();
    await expect(page.locator(".assistant-chats-group")).toHaveCount(0);
    await sessionsPlus(page).click();
    await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible();
  });
});

// The phone drawer has no New menu either; its group heads keep their icon buttons
// (agents page or CLIs, then "+"), each a full tap target that closes the drawer.
test.describe("the phone drawer", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const drawer = (page) => page.locator(".sidebar");
  const head = (page, group) => page.locator(`.${group}-group .sidebar-group-actions`);
  async function openDrawer(page) {
    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(drawer(page)).toHaveClass(/open/);
  }
  async function closesDrawer(page) {
    await expect(drawer(page)).not.toHaveClass(/open/);
  }
  const controls = [
    ["sessions", "button", "New session"],
    ["sessions", "link", "CLIs and extensions"],
    ["assistant-chats", "link", "New agent"],
    ["assistant-chats", "link", "Manage all agents"],
  ];

  test("shows the group icons as tap targets and no New menu", async ({ page }) => {
    await fixture(page);
    await agentsOn(page);
    await openDrawer(page);
    await expect(drawer(page).locator(".new-menu")).toHaveCount(0);
    // With no agents yet the Agents group is there with its icons too.
    await expect(page.locator(".assistant-chats-group")).toContainText(
      "Create your first agent to start a conversation.",
    );
    for (const [group, role, name] of controls) {
      const control = head(page, group).getByRole(role, { name, exact: true });
      await expect(control, name).toBeVisible();
      const box = await control.boundingBox();
      expect(Math.min(box.width, box.height), name).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });

  test("the Sessions + opens the launch dialog over a closed drawer", async ({
    page,
  }) => {
    await fixture(page);
    await agentsOn(page);
    await openDrawer(page);
    await head(page, "sessions").getByRole("button", { name: "New session" }).click();
    await closesDrawer(page);
    await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible();
  });

  test("the Sessions CLIs icon opens Coding", async ({ page }) => {
    await fixture(page);
    await openDrawer(page);
    await head(page, "sessions")
      .getByRole("link", { name: "CLIs and extensions" })
      .click();
    await closesDrawer(page);
    await expect(page).toHaveURL(/\/coding\/clis$/);
  });

  test("the Agents + opens the new agent wizard", async ({ page }) => {
    await fixture(page);
    await agentsOn(page);
    await openDrawer(page);
    await head(page, "assistant-chats").getByRole("link", { name: "New agent" }).click();
    await closesDrawer(page);
    await expect(page).toHaveURL(/\/agents\?new=1$/);
    await expect(
      page.getByRole("heading", { name: "New agent", level: 1 }),
    ).toBeVisible();
  });

  test("the Agents grid icon opens the agents page", async ({ page }) => {
    await fixture(page);
    await agentsOn(page);
    await openDrawer(page);
    await head(page, "assistant-chats")
      .getByRole("link", { name: "Manage all agents" })
      .click();
    await closesDrawer(page);
    await expect(page).toHaveURL(/\/agents$/);
  });

  test("with agents off, the drawer keeps the Sessions icons", async ({ page }) => {
    await fixture(page);
    await openDrawer(page);
    await expect(page.locator(".assistant-chats-group")).toHaveCount(0);
    await head(page, "sessions").getByRole("button", { name: "New session" }).click();
    await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible();
  });
});

for (const width of [1280, 390]) {
  test.describe(`the compact + at ${width}px`, () => {
    const narrow = width < 700;
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
    });

    test("offers Session and Agent in a menu", async ({ page }) => {
      await fixture(page);
      await agentsOn(page);
      await open(page, narrow);
      const button = compactNew(page, narrow);
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
    });

    test("Session opens the launch dialog", async ({ page }) => {
      await fixture(page);
      await agentsOn(page);
      await open(page, narrow);
      await compactNew(page, narrow).click();
      await menu(page).getByRole("menuitem", { name: "Session" }).click();
      await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible();
    });

    test("Escape closes the menu and returns focus to the button", async ({ page }) => {
      await fixture(page);
      await agentsOn(page);
      await open(page, narrow);
      await compactNew(page, narrow).click();
      await expect(menu(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu(page)).toHaveCount(0);
      await expect(compactNew(page, narrow)).toBeFocused();
      await expect(compactNew(page, narrow)).toHaveAttribute("aria-expanded", "false");
    });

    test("Agent is not offered while agents are off", async ({ page }) => {
      await fixture(page);
      await open(page, narrow);
      await compactNew(page, narrow).click();
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
