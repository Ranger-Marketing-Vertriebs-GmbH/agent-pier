import { test, expect } from "@playwright/test";
import path from "node:path";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

test.use({ locale: "en-GB" });

// AGENTPIER_SCREENSHOTS=<folder> also saves the reviewed scope for a pull request.
const screenshots = process.env.AGENTPIER_SCREENSHOTS;

test("the backup scope names what CLI profiles contribute and what never leaves", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.planComponents = ["cli-histories", "encrypted-managed-profiles"];
  state.planOmissions = [
    "CLI caches, logs, telemetry and files outside the profile allowlists",
    "Platform-specific installed tool binaries and caches",
    "CLI histories are only backed up in backups with a passphrase, and then encrypted",
  ];
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(baseURL + "/settings/backups");
    await page.getByRole("button", { name: "Prepare backup", exact: true }).click();
    await page.getByLabel("Include encrypted credentials", { exact: true }).check();
    const dialog = page.getByRole("dialog", { name: "Prepare backup" });
    await expect(
      dialog.getByText("CLI histories are only backed up in backups with a passphrase", {
        exact: false,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Review backup scope", exact: true }).click();
    for (const text of [
      "CLI histories (encrypted): Codex sessions and generated images, Claude Code projects, to-dos and file history, OpenCode sessions",
      "Logins, settings, instructions, skills and agents of managed CLI profiles (encrypted)",
      "CLI caches, logs, telemetry and files outside the profile allowlists",
      "CLI histories are only backed up in backups with a passphrase, and then encrypted",
    ])
      await expect(dialog.getByText(text, { exact: true })).toBeVisible();
    await expect(dialog.getByText("cli-histories")).toHaveCount(0);
    if (screenshots)
      await page.screenshot({
        path: path.join(screenshots, `backup-scope-${viewport.name}.png`),
        fullPage: true,
      });
  }
});
