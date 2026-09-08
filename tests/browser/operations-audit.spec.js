import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
test("audit pagination retains its high watermark across reload and resets filters without stale rows", async ({
  page,
}) => {
  await operationsFixture(page);
  await page.goto(baseURL + "/settings/audit");
  await expect(
    page.getByRole("heading", { name: "Aktivitätsprotokoll", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Aktivitätsprotokoll: Nächste Seite", exact: true })
    .click();
  await expect(page).toHaveURL(/before=26/);
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByLabel("Ergebnis", { exact: true }).selectOption("failure");
  await expect(page).not.toHaveURL(/page=2/);
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("article")).toContainText("Fehlgeschlagen");
});
