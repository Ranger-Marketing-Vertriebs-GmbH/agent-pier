import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings as setup } from "../helpers/assistant-settings-browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";

// Settings › Work › Team: "Use team" chooses how the lead involves its members.
const viewports = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 1000 },
};
const shots = process.env.TEAM_USAGE_SHOTS;
const usage = (page) => page.getByRole("radiogroup", { name: "Use team" });
const fits = async (page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);

for (const [label, viewport] of Object.entries(viewports)) {
  test.describe(`team usage on ${label}`, () => {
    test.beforeEach(({ page }) => page.setViewportSize(viewport));

    test("defaults to Suggest and saves another level with the team policy", async ({
      page,
    }) => {
      // A policy saved before the level existed reads as the default.
      const state = await setup(page);
      await page.goto(baseURL + settingsPath("work"));
      const group = usage(page);
      await expect(group.getByRole("radio", { name: "Suggest" })).toBeChecked();
      await expect(page.locator("#agent-team")).toContainText(
        "offers to involve a matching member in one sentence and waits for your yes",
      );
      await fits(page);
      await group.getByText("Autonomous", { exact: true }).click();
      await expect(group.getByRole("radio", { name: "Autonomous" })).toBeChecked();
      await expect(page.locator("#agent-team")).toContainText(
        "delegates suitable tasks on its own",
      );
      await fits(page);
      if (shots) {
        await page.locator("#agent-team").evaluate((e) => e.scrollIntoView());
        await page.screenshot({ path: `${shots}/team-usage-${label}-en.png` });
      }
      await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => state.work.length).toBe(1);
      expect(state.work[0]).toEqual({
        team: {
          revision: 1,
          usage: "autonomous",
          autonomous: false,
          memberShellSsh: false,
          maxMembers: 4,
          runTimeoutMinutes: 30,
        },
      });
      await expect(saveBar(page)).toHaveCount(0);
      await expect(group.getByRole("radio", { name: "Autonomous" })).toBeChecked();
    });

    test("shows the stored level and its hint", async ({ page }) => {
      await setup(page, {
        policies: {
          home: {
            revision: 3,
            usage: "onRequest",
            autonomous: false,
            maxMembers: 4,
            runTimeoutMinutes: 30,
          },
        },
      });
      await page.goto(baseURL + settingsPath("work"));
      await expect(usage(page).getByRole("radio", { name: "On request" })).toBeChecked();
      await expect(page.locator("#agent-team")).toContainText("only when you ask it to");
      // Arrow keys move between the levels like any radio group.
      await usage(page).getByRole("radio", { name: "On request" }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(usage(page).getByRole("radio", { name: "Suggest" })).toBeChecked();
      await expect(saveBar(page)).toBeVisible();
    });
  });
}
