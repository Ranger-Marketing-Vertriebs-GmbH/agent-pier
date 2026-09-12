import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
import { claudeRequest } from "../../server/features/requests/claude-hook.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`Claude multi-question dialog ${locale}`, () => {
    test.use({ locale });
    for (const width of [390, 1440]) {
      test(`all questions retain answers and submit together at ${width}px`, async ({
        page,
      }, testInfo) => {
        const en = locale === "en-GB";
        await page.setViewportSize({ width, height: width === 390 ? 600 : 1000 });
        const state = await operationsFixture(page);
        const adapter = claudeRequest({
          hook_event_name: "PreToolUse",
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which scope?",
                options: [{ label: "Tests" }, { label: "Docs" }],
                multiSelect: true,
              },
              {
                question: "Which target?",
                options: [{ label: "Local" }, { label: "Remote" }],
              },
              { question: "Any notes?", options: [] },
            ],
          },
        });
        state.requests = [
          {
            ...adapter.view,
            id: "claude-dialog",
            sessionId: "fixture-session",
            revision: 1,
            status: "pending",
            source: "claude",
          },
        ];
        await page.goto(baseURL + "/sessions/fixture-session/chat");
        const next = page.getByRole("button", {
          name: en ? "Next question" : "Nächste Frage",
          exact: true,
        });
        const previous = page.getByRole("button", {
          name: en ? "Previous question" : "Vorherige Frage",
          exact: true,
        });
        await expect(
          page.getByText(en ? "Question 1 of 3" : "Frage 1 von 3", { exact: true }),
        ).toBeVisible();
        await next.click();
        await expect(page.getByRole("alert")).toBeVisible();
        await page.getByLabel("Tests", { exact: true }).check();
        await page.getByLabel("Docs", { exact: true }).check();
        await next.click();
        await expect(
          page.getByText(en ? "Question 2 of 3" : "Frage 2 von 3", { exact: true }),
        ).toBeVisible();
        await page.getByLabel("Local", { exact: true }).check();
        await previous.click();
        await expect(page.getByLabel("Tests", { exact: true })).toBeChecked();
        await expect(page.getByLabel("Docs", { exact: true })).toBeChecked();
        await next.click();
        await expect(page.getByLabel("Local", { exact: true })).toBeChecked();
        await next.click();
        await page
          .getByRole("textbox", {
            name: en ? "Other answer: Any notes?" : "Andere Antwort: Any notes?",
            exact: true,
          })
          .fill("Keep the fixtures isolated");
        expect(state.calls.filter((call) => call.path.endsWith("/answer"))).toHaveLength(
          0,
        );
        await previous.click();
        await page.getByLabel("Remote", { exact: true }).check();
        await next.click();
        await expect(page.getByRole("textbox", { name: /Any notes/ })).toHaveValue(
          "Keep the fixtures isolated",
        );
        await expect(
          page.getByRole("button", {
            name: en ? "Send answer" : "Antwort senden",
            exact: true,
          }),
        ).toBeInViewport();
        await page.screenshot({
          path: testInfo.outputPath("claude-question-dialog.png"),
        });
        await page
          .getByRole("button", {
            name: en ? "Send answer" : "Antwort senden",
            exact: true,
          })
          .click();
        await expect(page.locator(".native-request")).toHaveCount(0);
        const calls = state.calls.filter((call) => call.path.endsWith("/answer"));
        expect(calls).toHaveLength(1);
        expect(
          adapter.answer(calls[0].body).hookSpecificOutput.updatedInput.answers,
        ).toEqual({
          "Which scope?": "Tests, Docs",
          "Which target?": "Remote",
          "Any notes?": "Keep the fixtures isolated",
        });
      });
    }
  });
}
