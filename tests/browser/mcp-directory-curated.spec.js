import { test, expect } from "@playwright/test";
import { chooseSource, fits, openWizard, phone } from "./mcp-wizard-fixture.js";
import { directorySetup, dto } from "./mcp-directory-fixture.js";

const noteName = "Before you set up REA";

async function searchRea(page) {
  await directorySetup(page, {
    directory: { pages: { rea: [[dto.rea, dto.reaLookalike]] } },
  });
  const wizard = await openWizard(page);
  await chooseSource(wizard, /Search the directory/);
  await wizard.getByLabel("Server name").fill("rea");
  await wizard.getByRole("button", { name: "Search", exact: true }).click();
  return wizard;
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("REA's directory entry and package step carry AgentPier's note", async ({
      page,
    }) => {
      const wizard = await searchRea(page);
      await wizard
        .getByRole("article", { name: "REA", exact: true })
        .getByRole("button", { name: "REA", exact: true })
        .click();
      const detail = page.getByRole("dialog", { name: "REA", exact: true });
      const note = detail.getByRole("region", { name: noteName });
      await expect(note.getByText("Note from AgentPier")).toBeVisible();
      for (const text of [
        /circumventing DRM, license checks or anti-cheat/,
        /Only morluto\/rea on GitHub and the npm package rea-agents by morluto/,
        /tick “Allow install scripts or source builds”/,
        /REA_MCP_INPUT_SCHEMA_PROFILE to compact/,
        /GHIDRA_INSTALL_DIR and JAVA_HOME/,
        /need an unsandboxed session/,
        /Do not run REA’s own “rea setup”/,
      ])
        await expect(note.getByText(text)).toBeVisible();
      await fits(page);
      if (label === "desktop")
        await detail.screenshot({ path: test.info().outputPath("rea-detail.png") });
      await detail.getByRole("button", { name: "Use this server" }).click();
      await wizard.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/step=package/);
      const stepNote = wizard.getByRole("region", { name: noteName });
      await expect(stepNote.getByText(/need an unsandboxed session/)).toBeVisible();
      await expect(stepNote.getByRole("heading", { level: 2 })).toHaveText(noteName);
      await fits(page);
    });

    test("a look-alike entry gets no note", async ({ page }) => {
      const wizard = await searchRea(page);
      await wizard
        .getByRole("article", { name: "REA Tools" })
        .getByRole("button", { name: "REA Tools" })
        .click();
      const detail = page.getByRole("dialog", { name: "REA Tools" });
      await expect(detail.getByText("io.github.morIuto")).toBeVisible();
      await expect(detail.getByRole("region", { name: noteName })).toHaveCount(0);
      await detail.getByRole("button", { name: "Use this server" }).click();
      await wizard.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/step=package/);
      await expect(wizard.getByLabel("Package", { exact: true })).toHaveValue(
        "rea-agent",
      );
      await expect(wizard.getByRole("region", { name: noteName })).toHaveCount(0);
    });
  });
}

test("typing the exact npm package shows the note; a similar name drops it", async ({
  page,
}) => {
  await directorySetup(page);
  const wizard = await openWizard(page);
  await chooseSource(wizard, "Package from npm or PyPI");
  const field = wizard.getByLabel("Package", { exact: true });
  await field.fill("rea-agents");
  const note = wizard.getByRole("region", { name: noteName });
  await expect(note.getByText(/its optional dependency frida/i)).toBeVisible();
  await field.fill("rea-agents-cli");
  await expect(note).toHaveCount(0);
});
