// AGENTPIER-456: ⌘K finds Files › Papierkorb, Hochladen and the notification settings
// (Ruhezeiten, Detailstufe, Testbenachrichtigung, App installieren), desktop and phone.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { explorerFixture } from "../helpers/file-explorer-browser.js";

const dialog = (page) => page.getByRole("dialog", { name: "Suchen" });
const field = (page) => dialog(page).getByRole("combobox");
const options = (page) => dialog(page).getByRole("option");

async function search(page, phone) {
  if (phone) {
    await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
    await page.locator(".sidebar .sidebar-menu-button").click();
    await page.locator("#sidebar-menu").getByRole("button", { name: "Suchen" }).click();
  } else {
    const mac = await page.evaluate(() => /mac/i.test(navigator.platform));
    await page.keyboard.press(mac ? "Meta+k" : "Control+k");
  }
  await expect(dialog(page)).toBeVisible();
}

for (const phone of [false, true])
  test.describe(phone ? "phone" : "desktop", () => {
    if (phone)
      test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("Papierkorb and Hochladen open the explorer's trash and upload panel", async ({
      page,
    }) => {
      await explorerFixture(page);
      // The search reads the quick-open lists the explorer fixture does not serve.
      await page.route(
        /\/api\/(pipelines|pipeline-runs|task-profiles)(\?.*)?$/,
        (route) =>
          route.fulfill({ json: { pipelines: [], runs: [], profiles: [], total: 0 } }),
      );
      await page.route("**/api/files/trash", (route) =>
        route.fulfill({ json: { entries: [], nextCursor: null } }),
      );
      await page.goto(baseURL + "/files");
      await page.getByRole("heading", { name: "Dateien", level: 1 }).waitFor();
      await search(page, phone);
      await field(page).fill("Papierkorb");
      await expect(options(page).first()).toContainText("Dateien › Papierkorb");
      await options(page).first().click();
      await expect(page).toHaveURL(/\/files\?panel=trash(&|$)/);
      await expect(
        page.getByRole("heading", { name: "Papierkorb", level: 2 }),
      ).toBeVisible();
      await search(page, phone);
      await field(page).fill("Hochladen");
      await expect(options(page).first()).toContainText("Hochladen");
      await options(page).first().click();
      await expect(page.getByRole("region", { name: "Uploads" })).toBeVisible();
      await expect(page.getByText("Dateien hochladen", { exact: true })).toBeVisible();
    });

    test("Ruhezeiten, Detailstufe, Testbenachrichtigung and App installieren open the notification settings", async ({
      page,
    }) => {
      await page.goto(baseURL + "/projects");
      await page.getByRole("heading", { name: "Projekte", level: 1 }).waitFor();
      for (const [query, label] of [
        ["Ruhezeiten", "Ruhezeiten"],
        ["Detailstufe", "Detailstufe"],
        ["Testbenachrichtigung", "Testbenachrichtigung senden"],
        ["App installieren", "App installieren"],
      ]) {
        await search(page, phone);
        await field(page).fill(query);
        await expect(options(page).first()).toContainText(label);
        await options(page).first().click();
        await expect(page).toHaveURL(/\/settings\/notifications$/);
        await page.goto(baseURL + "/projects");
        await page.getByRole("heading", { name: "Projekte", level: 1 }).waitFor();
      }
    });
  });
