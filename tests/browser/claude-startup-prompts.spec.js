import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

const themeRequest = {
  id: "theme",
  sessionId: "fixture-session",
  revision: 1,
  status: "pending",
  source: "claude",
  kind: "permission",
  presentation: "claudeStartupPrompt",
  subject: { dialog: "theme" },
  options: [
    { id: "1", label: "Auto (match terminal)" },
    { id: "2", label: "Dark mode" },
    { id: "3", label: "Light mode" },
  ],
};
const loginRequest = {
  ...themeRequest,
  id: "login",
  subject: { dialog: "login" },
  options: [],
};

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`Claude startup prompts ${locale}`, () => {
    test.use({ locale });
    test("onboarding dialogs hold chat messages and answer with one native choice", async ({
      page,
    }) => {
      const en = locale === "en-GB";
      await page.setViewportSize({ width: 390, height: 844 });
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/sessions/fixture-session/chat");
      const input = page.getByRole("textbox", {
        name: en ? "Message" : "Nachricht",
        exact: true,
      });
      await expect(input).toBeEnabled();
      await input.fill("Keep my Claude message");
      state.requests = [themeRequest];
      await expect(
        page.getByText(en ? "Choose Claude text style" : "Claude-Textstil wählen", {
          exact: true,
        }),
      ).toBeVisible();
      // A message sent now would wait for the answer; the draft stays editable.
      await expect(input).toBeEnabled();
      if (en)
        await page
          .locator(".chat-container .native-requests")
          .screenshot({ path: test.info().outputPath("claude-theme-mobile.png") });
      await page.getByRole("button", { name: "Light mode", exact: true }).click();
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue("Keep my Claude message");
      expect(state.calls.filter((c) => c.path.endsWith("/answer")).at(-1).body).toEqual({
        expectedRevision: 1,
        choice: "3",
      });
      state.requests = [loginRequest];
      await expect(
        page.getByText(en ? "Claude login required" : "Claude-Anmeldung erforderlich", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(input).toBeEnabled();
      await expect(
        page.getByRole("button", { name: en ? "Open terminal" : "Terminal öffnen" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: en ? "Answer in terminal" : "Im Terminal beantworten",
        }),
      ).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
    });
  });
}
