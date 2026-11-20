// Zugänge links to the CLIs' own accounts (AGENTPIER-391): owners look for Claude and
// Codex sign-ins under Connections, which live under CLIs and extensions › Accounts.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

const copy = {
  en: { link: /^CLI accounts/, back: "Connections", tab: "Accounts" },
  de: { link: /^CLI-Accounts/, back: "Zugänge", tab: "Accounts" },
};

for (const language of ["en", "de"])
  for (const [size, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ])
    test(`${language} ${size}: Connections leads to CLIs › Accounts and back`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await fixture(page);
      await page.addInitScript(
        (value) => localStorage.setItem("agentpier-language", value),
        language,
      );
      await page.goto(`${baseURL}/connections`);
      const link = page.getByRole("link", { name: copy[language].link });
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(
        /\/coding\/clis\?tab=accounts&returnTo=%2Fconnections/,
      );
      await expect(
        page.getByRole("tab", { name: copy[language].tab, selected: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: copy[language].back }).first().click();
      // Back to the category it came from (desktop opens Model access first).
      await expect(page).toHaveURL(/\/connections(\?section=models)?$/);
    });
