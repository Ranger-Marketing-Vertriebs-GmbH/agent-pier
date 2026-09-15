import { test, expect } from "@playwright/test";
import { fixture } from "./ssh-fixture.js";

test.use({ locale: "en-GB" });
test("Memory discovery failure is translated in the session dialog and preserves input", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/pipeline-profiles", (route) =>
    route.fulfill({ json: { profiles: [] } }),
  );
  await page.route("**/api/directories?**", (route) =>
    route.fulfill({ json: { path: "/fixture/project", parent: null, entries: [] } }),
  );
  await page.route("**/api/sessions", (route) =>
    route.fulfill({
      status: 409,
      json: {
        code: "MEMORY_DISCOVERY_CONFIG",
        error: "Untranslated diagnostic",
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Session name", { exact: true }).fill("Memory fixture");
  await dialog.getByRole("button", { name: "Choose directory", exact: true }).click();
  await dialog.getByRole("button", { name: "Use this directory", exact: true }).click();
  await dialog.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Memory discovery hooks could not be configured. Check the session hook configuration and try again.",
  );
  await expect(dialog.getByLabel("Session name", { exact: true })).toHaveValue(
    "Memory fixture",
  );
  await expect(page.getByText("Untranslated diagnostic")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("memory-discovery-en.png") });
});
