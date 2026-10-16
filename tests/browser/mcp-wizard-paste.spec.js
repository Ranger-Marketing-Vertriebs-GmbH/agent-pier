import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { fits, openWizard, phone, primary, wizardSetup } from "./mcp-wizard-fixture.js";

const fixture = (name) =>
  fs.readFileSync(new URL(`../fixtures/mcp-paste/${name}`, import.meta.url), "utf8");

async function paste(page, text) {
  const wizard = await openWizard(page);
  await wizard.getByRole("button", { name: "Paste setup from a guide" }).click();
  await expect(
    wizard.getByRole("heading", { level: 1, name: "Paste the setup" }),
  ).toBeFocused();
  await wizard.getByLabel("Setup from the guide").fill(text);
  await wizard.getByRole("button", { name: "Read setup" }).click();
  return wizard;
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("the OPNsense guide becomes a package with named gaps, nothing sent", async ({
      page,
    }) => {
      const state = await wizardSetup(page);
      const wizard = await paste(page, fixture("opnsense.json"));
      const card = wizard.getByRole("region", { name: "Here is what we found" });
      await expect(card.getByLabel("Name", { exact: true })).toHaveValue("opnsense");
      await expect(card.getByText("npm package opnsense-mcp-server")).toBeVisible();
      await expect(
        card.getByText("Pinned to an exact version when you install."),
      ).toBeVisible();
      await expect(
        card.getByText("The guide shows a placeholder for OPNSENSE_API_KEY."),
      ).toBeVisible();
      const dropped = card.getByRole("list", { name: "Not taken over" });
      await expect(
        dropped.getByText(/npx – AgentPier installs the package itself/),
      ).toBeVisible();
      await expect(dropped.getByText("-y – Only needed for npx.")).toBeVisible();
      await expect(dropped.getByText(/autoApprove/)).toBeVisible();
      await expect(card.getByText(/Published by Jane Doe, jdoe/)).toBeVisible();
      await expect(
        card.getByText(
          "All values are stored on this computer only and are never shown again.",
        ),
      ).toBeVisible();
      const sent = state.requests.filter(
        (r) => r.path !== "/api/mcp-servers" && r.path !== "/api/mcp-servers/cli-finds",
      );
      expect([...new Set(sent.map((r) => r.path))]).toEqual([
        "/api/mcp-packages/versions",
      ]);
      expect(JSON.stringify(state.requests)).not.toContain("192.168.1.1");
      await fits(page);
      await primary(wizard).click();
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Settings for opnsense" }),
      ).toBeVisible();
      const key = wizard.locator(".mcp-setting", { hasText: "OPNSENSE_API_KEY" });
      await expect(key.getByText("Required")).toBeVisible();
      await expect(key.getByText("Secret")).toBeVisible();
      await expect(
        wizard
          .locator(".mcp-setting", { hasText: "OPNSENSE_ALLOW_WRITES" })
          .getByText(/decides whether the server may change things/),
      ).toBeVisible();
      await primary(wizard).click();
      await expect(key.getByRole("alert")).toHaveText("Needed to start the server.");
      await key.getByLabel("Value", { exact: true }).fill("k");
      await wizard
        .locator(".mcp-setting", { hasText: "OPNSENSE_API_SECRET" })
        .getByLabel("Value", { exact: true })
        .fill("s");
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=install/);
      await page.goBack();
      await expect(page).toHaveURL(/step=settings/);
      await wizard.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/step=package/);
      await expect(wizard.getByLabel("Package", { exact: true })).toHaveValue(
        "opnsense-mcp-server",
      );
    });

    test("several servers are set up one at a time", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await paste(page, fixture("several.json"));
      await expect(
        wizard.getByText(
          "2 more servers in this block: github, fetch – set them up one at a time",
        ),
      ).toBeVisible();
      await wizard.getByRole("radio", { name: "github" }).check();
      const card = wizard.getByRole("region", { name: "Here is what we found" });
      await expect(card.getByText("Own command docker")).toBeVisible();
      await expect(card.getByText(/Docker is not supported as a package/)).toBeVisible();
      await expect(
        card.getByText(
          /GITHUB_PERSONAL_ACCESS_TOKEN points to another setting \(GITHUB_TOKEN\)/,
        ),
      ).toBeVisible();
    });

    test("invalid JSON names line and column; TOML and shell lines are not understood", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await paste(
        page,
        '{\n "mcpServers": {\n  "a": { "command": "x" \n}',
      );
      await expect(wizard.getByRole("alert")).toHaveText(
        "This is not valid JSON. Copy the whole block including the braces { }. Line 4, column 2.",
      );
      await wizard
        .getByLabel("Setup from the guide")
        .fill('[mcp_servers.fetch]\ncommand = "uvx"');
      await wizard.getByRole("button", { name: "Read setup" }).click();
      await expect(wizard.getByRole("alert")).toHaveText(
        "This is not JSON. Paste the JSON variant from the guide, or set the server up by hand.",
      );
    });

    test("a single command line becomes a PyPI package", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await paste(page, "uvx mcp-server-fetch --ignore-robots-txt");
      const card = wizard.getByRole("region", { name: "Here is what we found" });
      await expect(card.getByText("PyPI package mcp-server-fetch")).toBeVisible();
      await expect(card.getByText("--ignore-robots-txt")).toBeVisible();
      await expect(card.getByText(/Published by/)).toBeVisible();
      await primary(wizard).click();
      await expect(card.getByRole("alert")).toHaveText(
        "Enter 1 to 30 letters, digits, hyphens or underscores, starting with a letter.",
      );
      await card.getByLabel("Name", { exact: true }).fill("fetch");
      await expect(card.getByRole("alert")).toHaveCount(0);
      await primary(wizard).click();
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Settings for fetch" }),
      ).toBeVisible();
      // Back to Paste and on again keeps the name typed on the card.
      const back = wizard.getByRole("button", { name: "Back", exact: true });
      await back.click();
      await expect(page).toHaveURL(/step=package/);
      await back.click();
      await expect(page).toHaveURL(/step=paste/);
      await expect(card.getByLabel("Name", { exact: true })).toHaveValue("fetch");
      await primary(wizard).click();
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Settings for fetch" }),
      ).toBeVisible();
    });

    test("an oversized paste is named too long, not invalid JSON", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await paste(
        page,
        `{"mcpServers":{"a":{"command":"x","args":["${"y".repeat(70 * 1024)}"]}}}`,
      );
      await expect(wizard.getByRole("alert")).toHaveText(
        "This is too long for a setup block.",
      );
    });

    test("the rest of a pasted block waits for Add another server", async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, "One full flow per viewport is covered above.");
      await wizardSetup(page);
      const wizard = await paste(page, fixture("several.json"));
      const card = wizard.getByRole("region", { name: "Here is what we found" });
      await expect(card.getByText(/Published by/)).toBeVisible();
      await primary(wizard).click();
      await primary(wizard).click();
      await wizard
        .getByRole("region", { name: "Install this package?" })
        .getByRole("button", { name: "Install" })
        .click();
      await wizard.getByRole("button", { name: "Continue", exact: true }).click();
      await wizard.getByRole("button", { name: "Skip for now" }).click();
      await wizard.getByRole("button", { name: "Add another server" }).click();
      await expect(page).toHaveURL(/step=paste/);
      // The saved server is gone from the chooser; the next one waits, preselected.
      await expect(wizard.getByRole("radio", { name: "github" })).toBeChecked();
      await expect(wizard.getByRole("radio", { name: "filesystem" })).toHaveCount(0);
      await expect(
        wizard.getByText(
          "1 more server in this block: fetch – set them up one at a time",
        ),
      ).toBeVisible();
      await expect(card.getByText("Own command docker")).toBeVisible();
      await expect(card.getByLabel("Name", { exact: true })).toHaveValue("github");
      // A name already in use is refused in the owner's language before anything runs.
      await card.getByLabel("Name", { exact: true }).fill("filesystem");
      await primary(wizard).click();
      await expect(card.getByRole("alert")).toHaveText(
        "A server with this name already exists. Choose another name.",
      );
      await expect(page).toHaveURL(/step=paste/);
    });
  });
}
