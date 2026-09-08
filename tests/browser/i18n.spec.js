import { test, expect } from "@playwright/test";

test("login detects browser language and preserves typed values when switching", async ({
  page,
}) => {
  await page.route("**/auth/status", (route) =>
    route.fulfill({
      json: { configured: true, authenticated: false },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Anmelden", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Benutzername", { exact: true }).fill("my unchanged username");
  await page.getByLabel("Sprache", { exact: true }).selectOption("en");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue(
    "my unchanged username",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.reload();
  await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});

test("settings switches the workspace immediately and keeps unsaved form values", async ({
  page,
  context,
  browserName,
}) => {
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
  const directory = page.locator(".settings-form input").first();
  await directory.fill("/tmp/unchanged-language-draft");
  await page.getByLabel("Sprache", { exact: true }).selectOption("en");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(directory).toHaveValue("/tmp/unchanged-language-draft");
  const other = await context.newPage();
  await other.goto("/settings");
  await expect(other.getByLabel("Language", { exact: true })).toHaveValue("en");
  await other.getByLabel("Language", { exact: true }).selectOption("de");
  await expect(
    page.getByRole("heading", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
  await expect(directory).toHaveValue("/tmp/unchanged-language-draft");
  await other.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).not.toBeInViewport();
  await page.screenshot({
    path: `/tmp/agentpier-language-de-${browserName}.png`,
    fullPage: true,
  });
  await page.getByLabel("Sprache", { exact: true }).selectOption("en");
  await expect(page).toHaveTitle("AgentPier — Your terminal. Anywhere.");
  await page.screenshot({
    path: `/tmp/agentpier-language-en-${browserName}.png`,
    fullPage: true,
  });
});

test.describe("English browser", () => {
  test.use({ locale: "en-GB" });
  test("starts in English without a saved choice", async ({ page }) => {
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});
