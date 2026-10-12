import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`update channels ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 } });
    test("selection persists and clears the previous offer", async ({
      page,
    }, testInfo) => {
      const state = await operationsFixture(page);
      const en = locale === "en-GB";
      await page.goto("/settings/updates");
      const select = page.getByRole("combobox", {
        name: en ? "Update channel" : "Updatekanal",
        exact: true,
      });
      await expect(select).toHaveValue("stable");
      await page
        .getByRole("button", {
          name: en ? "Check for updates" : "Nach Updates suchen",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "1.1.0", exact: true }),
      ).toBeVisible();
      await select.selectOption("preview");
      await expect(select).toHaveValue("preview");
      await expect(page.getByRole("heading", { name: "1.1.0", exact: true })).toHaveCount(
        0,
      );
      expect(
        state.calls.some(
          (call) =>
            call.path.endsWith("/releases/channel") &&
            call.method === "PUT" &&
            call.body.updateChannel === "preview",
        ),
      ).toBe(true);
      await page.reload();
      await expect(select).toHaveValue("preview");
      await expect(
        page.getByText(
          en
            ? /Preview includes release candidates/
            : /Preview enthält Release Candidates/,
        ),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("update-channel-preview.png"),
        fullPage: true,
      });
      state.fail = "/operations/releases/channel";
      await select.selectOption("stable");
      await expect(page.getByText("Fixture conflict", { exact: true })).toBeVisible();
      await expect(select).toHaveValue("preview");
      state.fail = "";
      await select.selectOption("stable");
      await expect(select).toHaveValue("stable");
    });
    test("custom sources explain why the channel selection is managed", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      state.releases.updateChannelManaged = true;
      await page.goto("/settings/updates");
      await expect(page.getByRole("combobox")).toBeDisabled();
      await expect(
        page.getByText(
          locale === "en-GB"
            ? /A custom update source is configured/
            : /Eine eigene Update-Quelle ist eingerichtet/,
        ),
      ).toBeVisible();
    });
  });
}
