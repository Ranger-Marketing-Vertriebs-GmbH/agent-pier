import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function announceNewBuild(page) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route("**/auth/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "x-agentpier-build": "ffffffffffffffff" },
    });
  });
}

test("a newer server build shows a dismissible reload notice", async ({ page }) => {
  await announceNewBuild(page);
  await page.goto(baseURL);
  const notice = page.getByRole("status").filter({ hasText: "New version available" });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toBeHidden();
});

test("reload in the notice reloads the page", async ({ page }) => {
  await announceNewBuild(page);
  await page.goto(baseURL);
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await reloaded;
});

test("the artifact viewer also shows the notice", async ({ page }) => {
  await announceNewBuild(page);
  await page.goto(baseURL + "/artifacts/view/missing-artifact");
  await expect(page.getByText("New version available")).toBeVisible();
});

test("a failed lazy module after an update explains the new version", async ({
  page,
}) => {
  await announceNewBuild(page);
  await page.route("**/assets/SettingsPage-*.js", (route) => route.abort());
  await page.goto(baseURL);
  await expect(page.getByText("New version available")).toBeVisible();
  await page.goto(baseURL + "/settings");
  await expect(
    page.getByRole("heading", { name: "A new version is available" }),
  ).toBeVisible();
});
