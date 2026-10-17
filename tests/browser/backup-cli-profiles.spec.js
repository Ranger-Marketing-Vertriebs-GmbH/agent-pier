import { test, expect } from "@playwright/test";
import path from "node:path";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

test.use({ locale: "en-GB" });

// AGENTPIER_SCREENSHOTS=<folder> also saves the reviewed scope for a pull request.
const screenshots = process.env.AGENTPIER_SCREENSHOTS;

test("the backup scope names what is encrypted and what never leaves", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  // The fixture plan always lists the chat history.
  state.planComponents = [
    "terminal",
    "agentbus-history",
    "cli-histories",
    "encrypted-managed-profiles",
  ];
  state.planOmissions = [
    "CLI caches, logs, telemetry and files outside the profile allowlists",
    "Platform-specific installed tool binaries and caches",
  ];
  const note =
    "Without a passphrase, histories are left out of this backup. To back them up encrypted, also choose “Include encrypted credentials” and set a passphrase.";
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(baseURL + "/settings/backups");
    await page.getByRole("button", { name: "Prepare backup", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Prepare backup" });
    await expect(
      dialog.getByText(
        "they are only backed up encrypted, in backups with a passphrase",
        {
          exact: false,
        },
      ),
    ).toBeVisible();
    // What stays unencrypted is named as well.
    await expect(
      dialog.getByText(
        "pipeline history and artifacts (unpinned ones only with history)",
        {
          exact: false,
        },
      ),
    ).toBeVisible();
    // Without a passphrase, the dialog says that histories are left out and how
    // to back them up encrypted.
    await expect(dialog.getByText(note, { exact: true })).toBeVisible();
    await page.getByLabel("Include encrypted credentials", { exact: true }).check();
    await expect(dialog.getByText(note, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Review backup scope", exact: true }).click();
    for (const text of [
      "CLI histories (encrypted): Codex sessions and generated images, Claude Code projects, to-dos and file history, OpenCode sessions",
      "Logins, settings, instructions, skills and agents of managed CLI profiles (encrypted)",
      "Chat history (encrypted)",
      "Terminal captures (encrypted)",
      "AgentBus history (encrypted)",
      "CLI caches, logs, telemetry and files outside the profile allowlists",
    ])
      await expect(dialog.getByText(text, { exact: true })).toBeVisible();
    // With credentials and a passphrase, no history is listed as left out.
    await expect(
      dialog
        .locator(".operations-list li")
        .filter({ hasText: /histories \(set a passphrase/ }),
    ).toHaveCount(0);
    await expect(dialog.getByText("cli-histories")).toHaveCount(0);
    if (screenshots)
      await page.screenshot({
        path: path.join(screenshots, `backup-scope-${viewport.name}.png`),
        fullPage: true,
      });
  }
});
