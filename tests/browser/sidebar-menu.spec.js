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
  for (const name of ["Artifacts", "Projekte", "Dateien", "Pipelines", "Accounts"])
    await expect(popover(page).getByRole("button", { name, exact: true })).toBeVisible();
  await expect(popover(page).locator(".host-status")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("outside taps, the scrim and navigation close the menu", async ({ page }) => {
  await page.goto(baseURL);
  await trigger(page).click();
  await page.locator("main").click({ position: { x: 600, y: 400 } });
  await expect(popover(page)).toBeHidden();
  await trigger(page).click();
  await page.locator(".sidebar-menu-scrim").click({ position: { x: 20, y: 600 } });
  await expect(popover(page)).toBeHidden();
  await trigger(page).click();
  await popover(page).getByRole("button", { name: "Einstellungen", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(popover(page)).toBeHidden();
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
