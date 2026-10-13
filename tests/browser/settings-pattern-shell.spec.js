import { test, expect } from "@playwright/test";
import { startSettingsHarness } from "../helpers/settings-pattern-harness.js";

test.describe.configure({ timeout: 90000 });
let harness;
test.beforeAll(async () => {
  harness = await startSettingsHarness();
});
test.afterAll(async () => {
  await harness?.close();
});
const open = (page, query = "") =>
  page.goto(`${harness.url}?fixture=shell${query ? `&${query}` : ""}`);

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a top-level page shows the sidebar button, title and subtitle", async ({
    page,
  }) => {
    await open(page);
    const heading = page.locator(".settings-shell-heading");
    expect(Math.round((await heading.boundingBox()).height)).toBe(56);
    const menu = page.getByRole("button", { name: "Navigation öffnen" });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(page.getByTestId("log")).toHaveText("menu");
    await expect(
      page.getByRole("heading", { level: 1, name: "Einstellungen" }),
    ).toBeVisible();
    await expect(page.getByText("Lokal gespeichert")).toBeVisible();
    await expect(page.getByText("Arbeitsbereich, Zugriff und Betrieb")).toBeHidden();
    await expect(page.locator(".settings-shell-header")).toHaveCSS(
      "border-bottom-width",
      "0px",
    );
  });

  test("a subpage shows the back button and the header border without tabs", async ({
    page,
  }) => {
    await open(page, "leading=back&tabs=0");
    await page.getByRole("button", { name: "Zurück" }).click();
    await expect(page.getByTestId("log")).toHaveText("back");
    await expect(page.locator(".settings-shell-header")).toHaveCSS(
      "border-bottom-width",
      "1px",
    );
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the desktop header carries the description and the content is 720px wide", async ({
    page,
  }) => {
    await open(page);
    expect(
      Math.round((await page.locator(".settings-shell-heading").boundingBox()).height),
    ).toBe(64);
    await expect(page.getByRole("button", { name: "Navigation öffnen" })).toBeHidden();
    await expect(page.getByText("Arbeitsbereich, Zugriff und Betrieb")).toBeVisible();
    await expect(page.getByText("Lokal gespeichert")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", "17px");
    const content = await page.locator(".settings-shell-content").boundingBox();
    expect(Math.round(content.width)).toBe(720);
    expect(Math.abs(content.x + content.width / 2 - 640)).toBeLessThanOrEqual(2);
    await expect(page.getByRole("button", { name: "Aktion" })).toBeVisible();
  });
});
