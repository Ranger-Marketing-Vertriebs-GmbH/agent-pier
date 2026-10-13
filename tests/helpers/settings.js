import { expect } from "@playwright/test";

// Locators for the settings pattern pages.
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The bottom bar; it exists only while a tab or subpage has unsaved changes. */
export const settingsBar = (page) =>
  page.getByRole("region", { name: /^(Ungespeicherte Änderungen|Unsaved changes)$/ });

/** A row that opens a subpage; its accessible name starts with the row label. */
export const settingsRow = (page, label) =>
  page.getByRole("link", { name: new RegExp(`^${escape(label)}`) });

/** The UI language is a draft of the workspace tab: choose it, then save the tab. */
export async function chooseLanguage(page, language) {
  if ((await page.locator("html").getAttribute("lang")) === language) return;
  await page.getByLabel(/^(Sprache|Language)$/).selectOption(language);
  const bar = settingsBar(page);
  // A conflict would need a decision; this helper only saves.
  await expect(
    bar.getByRole("button", { name: /^(Trotzdem überschreiben|Overwrite anyway)$/ }),
  ).toHaveCount(0);
  await bar
    .getByRole("button", { name: /^(Einstellungen speichern|Save settings)$/ })
    .click();
  await expect(page.locator("html")).toHaveAttribute("lang", language);
}
