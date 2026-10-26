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
const open = (page, lang = "de") => page.goto(`${harness.url}?fixture=list&lang=${lang}`);
const log = (page) => page.getByTestId("log");

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("an info hint is a disclosure that inserts the text verbatim", async ({ page }) => {
  await open(page);
  const button = page
    .locator(".toggle-row")
    .getByRole("button", { name: "Hinweis anzeigen" });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const panel = page.locator(`#${await button.getAttribute("aria-controls")}`);
  await expect(panel).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toHaveText("Speichert Notizen zwischen Unterhaltungen.");
  await button.click();
  await expect(panel).toBeHidden();
  const box = await button.boundingBox();
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([20, 20]);
});

test("toggles are switches that work with the keyboard", async ({ page }) => {
  await open(page);
  const toggle = page.getByRole("switch", { name: "Gedächtnis" });
  await expect(toggle).not.toBeChecked();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await expect(log(page)).toContainText("memory:true");
  const box = await toggle.boundingBox();
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([38, 22]);
  await page.getByText("Gedächtnis", { exact: true }).click();
  await expect(toggle).not.toBeChecked();
});

test("rows show values, statuses, navigation, menus and delete actions", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByText("—", { exact: true })).toBeVisible();
  await expect(page.locator(".list-row-status.ok")).toHaveText("Verbunden");
  await expect(page.locator(".list-row-status.warn")).toHaveText("1.29.0 verfügbar");
  await page.getByRole("button", { name: /Gespeicherte Notizen/ }).click();
  await expect(log(page)).toContainText("open:notes");
  const menu = page.getByRole("button", { name: "Weitere Aktionen" });
  await expect(menu).toHaveAttribute("aria-haspopup", "menu");
  const menuBox = await menu.boundingBox();
  expect([Math.round(menuBox.width), Math.round(menuBox.height)]).toEqual([40, 40]);
  await menu.click();
  await expect(log(page)).toContainText("menu:plugin");
  await page.getByRole("button", { name: "ls entfernen" }).click();
  await expect(log(page)).toContainText("delete:ls");
});

test("number, select, radio, checkbox and segmented controls report changes", async ({
  page,
}) => {
  await open(page);
  const number = page.getByRole("spinbutton", { name: "Max. Mitglieder" });
  const box = await number.boundingBox();
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([64, 34]);
  await number.fill("6");
  await expect(log(page)).toContainText("members:6");
  await page.getByRole("combobox", { name: "Sprache der Hinweise" }).selectOption("en");
  await expect(log(page)).toContainText("language:en");
  await page.getByRole("radio", { name: "Mit Freigabe" }).check();
  await expect(log(page)).toContainText("shell:approval");
  await page.getByRole("checkbox", { name: /GitHub/ }).check();
  await expect(log(page)).toContainText("server:true");
  await expect(page.getByText("stdio", { exact: true })).toBeVisible();
  await page
    .getByRole("radiogroup", { name: "Ansicht" })
    .getByRole("radio", { name: "Archiv" })
    .check();
  await expect(log(page)).toContainText("segment:archive");
});

test("group actions and the Accounts reference row navigate in-app", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "+ Erinnerung erstellen" }).click();
  await expect(log(page)).toContainText("action:reminder");
  const reference = page.getByRole("link", { name: /Suchanbieter/ });
  await expect(reference).toHaveAttribute(
    "href",
    "/connections?section=services&item=web-search",
  );
  await expect(reference).toContainText("Zentral unter Zugänge");
  await reference.click();
  await expect(log(page)).toContainText("accounts:services/web-search");
  expect(new URL(page.url()).searchParams.get("fixture")).toBe("list");
});

test("a reference row without an address is a button and a disabled link row stays put", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: /Sprachdienst/ }).click();
  await expect(log(page)).toContainText("accounts:services/speech");
  const before = page.url();
  // aria-disabled makes Playwright wait for the row to enable; click it anyway.
  await page.getByRole("link", { name: /Gesperrter Link/ }).click({ force: true });
  expect(page.url()).toBe(before);
});

test("shared copy follows the language", async ({ page }) => {
  await open(page, "en");
  await expect(page.getByRole("button", { name: "Show hint" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Suchanbieter/ })).toContainText(
    "Managed centrally in Connections",
  );
  await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();
});
