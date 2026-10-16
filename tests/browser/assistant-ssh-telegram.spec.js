import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings } from "../helpers/assistant-settings-browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";

test("the Telegram tab explains that SSH accesses block a bot for other people", async ({
  page,
}) => {
  await setupAssistantSettings(page);
  await page.route(/\/api\/assistant-telegram-senders\//, (route) =>
    route.fulfill({
      json: {
        assistantId: "home",
        bot: null,
        status: null,
        voice: true,
        shell: "off",
        ssh: true,
      },
    }),
  );
  await page.goto(baseURL + settingsPath("telegram"));
  const section = page.getByRole("region", { name: "Telegram for other people" });
  await expect(section.getByText("This agent has SSH accesses.")).toBeVisible();
  await expect(section.getByLabel("Bot token")).toHaveCount(0);
});
