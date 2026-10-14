import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
import { fixture as sshFixture } from "./ssh-fixture.js";

// Legacy form dialogs whose own action row became the sticky footer must still fit
// a phone exactly: no sideways scroll, footer inside the dialog.
async function expectFits(dialog) {
  await expect(dialog).toBeVisible();
  const fit = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const footer = element.querySelector(
      ":scope > * > :is(.operations-actions, .ssh-actions):last-child",
    );
    const bar = footer?.getBoundingClientRect();
    return {
      sideways: element.scrollWidth - element.clientWidth,
      footer: !bar || (bar.left >= box.left - 0.5 && bar.right <= box.right + 0.5),
    };
  });
  expect(fit).toEqual({ sideways: 0, footer: true });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test("backup, restore and confirm dialogs fit a phone", async ({ page }) => {
  await operationsFixture(page);
  await page.goto(baseURL + "/settings/backups");
  await page.getByRole("button", { name: "Sicherung vorbereiten", exact: true }).click();
  await expectFits(page.getByRole("dialog"));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page
    .getByRole("button", { name: "Sicherung prüfen und wiederherstellen", exact: true })
    .click();
  await expectFits(page.getByRole("dialog"));
  await page.getByLabel("Sicherungsdatei", { exact: true }).setInputFiles({
    name: "fixture.apb",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("fixture archive"),
  });
  await page.getByRole("button", { name: "Archiv prüfen", exact: true }).click();
  await page
    .getByLabel("Neues Datenverzeichnis", { exact: true })
    .fill("/fixture/restored");
  await page.getByLabel("Imported project", { exact: true }).fill("/fixture/project");
  await page
    .getByRole("button", { name: "In neuem Verzeichnis wiederherstellen", exact: true })
    .click();
  // The confirmation opens above the restore dialog.
  await expect(page.getByRole("dialog")).toHaveCount(2);
  await expectFits(page.getByRole("dialog").last());
});

test("the remote access warning fits a phone", async ({ page }) => {
  await operationsFixture(page);
  await page.goto(baseURL + "/settings/remote");
  await page.getByRole("switch", { name: "Netzwerkzugriff" }).click();
  await expectFits(page.getByRole("dialog"));
});

test("the SSH access form fits a phone and shows Global as a real choice", async ({
  page,
}) => {
  await sshFixture(page);
  await page.goto(baseURL + "/settings/ssh");
  await page.getByRole("button", { name: "Zugang hinzufügen", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expectFits(dialog);
  const colour = (locator) =>
    locator.evaluate((element) => getComputedStyle(element).color);
  const owner = dialog.getByRole("combobox").first();
  await expect(owner).toHaveValue("");
  expect(await colour(owner)).toBe(
    await colour(dialog.getByLabel("Name", { exact: true })),
  );
});
