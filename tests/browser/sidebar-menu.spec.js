// tests/browser/sidebar-menu.spec.js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { openMenu } from "../helpers/navigation.js";

const trigger = (page) => page.locator(".sidebar .sidebar-menu-button");
const popover = (page) => page.locator("#sidebar-menu");

test("the menu keeps the landmark, opens, and closes on Escape with focus restored", async ({
  page,
}) => {
  await page.goto(baseURL);
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav).toBeVisible();
  await expect(popover(page)).toBeHidden();
  await trigger(page).click();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect(popover(page).getByRole("button", { name: "Übersicht" })).toBeFocused();
  for (const name of ["Artifacts", "Projekte", "Dateien", "Pipelines", "Zugänge"])
    await expect(popover(page).getByRole("button", { name, exact: true })).toBeVisible();
  await expect(popover(page).locator(".host-status")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("outside taps, the scrim and navigation close the menu", async ({ page }) => {
  await page.goto(baseURL);
  await trigger(page).click();
  await page.locator(".sidebar ~ main").click({ position: { x: 600, y: 400 } });
  await expect(popover(page)).toBeHidden();
  await trigger(page).click();
  await page.locator(".sidebar-menu-scrim").click({ position: { x: 20, y: 600 } });
  await expect(popover(page)).toBeHidden();
  await trigger(page).click();
  await popover(page).getByRole("button", { name: "Einstellungen", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(popover(page)).toBeHidden();
});

test("choosing a menu item returns focus to the menu button", async ({ page }) => {
  await page.goto(baseURL);
  await trigger(page).click();
  await popover(page).getByRole("button", { name: "Übersicht", exact: true }).click();
  await expect(popover(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("on phones Escape closes the menu first and the drawer second", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL);
  const drawer = page.locator(".sidebar");
  await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await expect(drawer).toHaveClass(/open/);
  await trigger(page).click();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(drawer).toHaveClass(/open/);
  await expect(trigger(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toHaveClass(/open/);
});

test("the popover fits a 240 px sidebar and a 320 px phone", async ({ page }) => {
  for (const size of [
    { width: 1100, height: 800 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(baseURL);
    const menu = await openMenu(page);
    const box = await menu.boundingBox();
    const aside = await page.locator(".sidebar").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(aside.x);
    expect(box.x + box.width).toBeLessThanOrEqual(aside.x + aside.width);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    await page.keyboard.press("Escape");
  }
});

test("desktop sidebar is 280 px, 240 px below 1150 px, and never inert", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);
  const aside = page.locator(".sidebar");
  // The app's own main, not the startup or login card that may still be mounted.
  const main = page.locator(".sidebar ~ main");
  await expect(main).toHaveCSS("margin-left", "280px");
  expect(await aside.evaluate((node) => node.inert)).toBe(false);
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(main).toHaveCSS("margin-left", "240px");
});

test("the closed phone drawer is inert and fits 320 px without horizontal scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(baseURL);
  const aside = page.locator(".sidebar");
  await expect.poll(() => aside.evaluate((node) => node.inert)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement.closest(".sidebar"))).toBe(
    false,
  );
  await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await expect.poll(() => aside.evaluate((node) => node.inert)).toBe(false);
  expect((await aside.boundingBox()).width).toBe(264);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await aside.boundingBox()).width).toBe(316);
});

test("agents and sessions share one scroll container", async ({ page }) => {
  await page.goto(baseURL);
  await expect(page.locator(".sidebar-scroll")).toBeVisible();
  const scrollers = await page.locator(".sidebar *").evaluateAll((nodes) =>
    nodes
      .filter((node) => !node.closest("#sidebar-menu"))
      .filter((node) => ["auto", "scroll"].includes(getComputedStyle(node).overflowY))
      .map((node) => node.className),
  );
  expect(scrollers).toEqual(["sidebar-scroll"]);
});

test("group headers stay pinned while the list scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.sessions = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      name: `Session ${i}`,
      tool: "codex",
      cwd: `/work/p${i}`,
      status: "running",
      activity: { state: "idle", label: "Bereit" },
    }));
    await route.fulfill({ response, json });
  });
  await page.goto(baseURL);
  const header = page.locator(".sessions-group > .sidebar-group-head");
  // Scroll only once the long list is rendered; WebKit may still be laying it out.
  await expect(page.getByText("Session 29")).toBeAttached();
  const scroller = page.locator(".sidebar-scroll");
  await expect
    .poll(async () => {
      await scroller.evaluate((node) => node.scrollTo(0, 400));
      const [h, s] = await Promise.all([header.boundingBox(), scroller.boundingBox()]);
      return Math.round(h.y - s.y);
    })
    .toBe(0);
  await expect(header).toHaveCSS("position", "sticky");
});

test("Escape closes the menu when focus fell back to the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL);
  const drawer = page.locator(".sidebar");
  await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await trigger(page).click();
  // A click on a non-focusable part of the popover leaves focus on the body.
  await popover(page).locator(".sidebar-menu-label").first().click();
  await expect(popover(page)).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(drawer).toHaveClass(/open/);
  await expect(trigger(page)).toBeFocused();
});

test("the sidebar head follows the handoff measurements", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);
  const collapse = await page.locator(".sidebar-collapse").boundingBox();
  expect([collapse.width, collapse.height]).toEqual([32, 32]);
  // No "+ New" button: the brand is followed by the inbox entry.
  await expect(page.locator(".sidebar-launch, .sidebar .new-menu")).toHaveCount(0);
  const brand = await page.locator(".sidebar-head .brand").boundingBox();
  const inbox = await page.locator(".sidebar-inbox").boundingBox();
  expect(inbox.y).toBeGreaterThanOrEqual(brand.y + brand.height);
  expect(inbox.y - (brand.y + brand.height)).toBeLessThanOrEqual(16);
});

// WebKit can drop a media query "change" event when the viewport crosses the phone
// breakpoint, which left the sidebar inert on desktop and every click on it landing
// on the app behind (AGENTPIER-50). Suppressing the event here reproduces that loss.
test("the sidebar stays usable when the phone breakpoint change event is lost", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const add = MediaQueryList.prototype.addEventListener;
    MediaQueryList.prototype.addEventListener = function (type, ...rest) {
      if (type !== "change") add.call(this, type, ...rest);
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL);
  await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".sidebar")).not.toHaveAttribute("inert");
  await trigger(page).click();
  await expect(popover(page)).toBeVisible();
});
