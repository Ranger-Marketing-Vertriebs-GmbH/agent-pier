import { test, expect } from "@playwright/test";
import { actionsFixture } from "../helpers/file-actions-browser.js";
import { baseURL } from "../helpers/browser.js";

for (const language of ["en", "de"])
  for (const mode of ["absent", "throws", "rejects", "success"])
    test(`copy path ${mode} reports ${language} feedback and restores the action owner`, async ({
      page,
    }, testInfo) => {
      await actionsFixture(page);
      await page.addInitScript((mode) => {
        window.copiedPaths = [];
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value:
            mode === "absent"
              ? undefined
              : {
                  writeText(text) {
                    if (mode === "throws") throw new Error("unavailable");
                    if (mode === "rejects") return Promise.reject(new Error("denied"));
                    window.copiedPaths.push(text);
                    return Promise.resolve();
                  },
                },
        });
      }, mode);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(baseURL + "/settings");
      await page.getByLabel(/Sprache|Language/).selectOption(language);
      await page.goto(baseURL + "/files");
      const trigger = page.getByRole("button", {
        name: language === "en" ? "Actions for a.txt" : "Aktionen für a.txt",
        exact: true,
      });
      await trigger.click();
      await page
        .getByRole("menuitem", {
          name: language === "en" ? "Copy path" : "Pfad kopieren",
          exact: true,
        })
        .click();
      const region = page.getByRole("region", {
        name: language === "en" ? "File actions" : "Dateiaktionen",
        exact: true,
      });
      await expect(region).toContainText(
        mode === "success"
          ? language === "en"
            ? "Copied to clipboard."
            : "In die Zwischenablage kopiert."
          : language === "en"
            ? "could not be copied"
            : "konnte nicht kopiert werden",
      );
      await expect(trigger).toBeFocused();
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => window.copiedPaths)).toEqual(
        mode === "success" ? ["/home/test/a.txt"] : [],
      );
      if (mode === "absent")
        await page.screenshot({ path: testInfo.outputPath(`clipboard-${language}.png`) });
    });
