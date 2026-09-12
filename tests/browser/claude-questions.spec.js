import { test, expect } from "@playwright/test";
import { claudeRequest } from "../../server/features/requests/claude-hook.js";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 390, height: 500 } });
    test("Claude fallback permission presents questions and submits answers", async ({
      page,
    }) => {
      const native = claudeRequest({
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              header: "Scope",
              question: "Which checks should run?",
              multiSelect: true,
              options: [
                { label: "Unit", description: "Fast isolated checks" },
                { label: "Browser", description: "Verify the visible behavior" },
              ],
            },
            {
              header: "Target",
              question: "Where should they run?",
              options: [{ label: "Local", description: "Use this machine" }],
            },
          ],
        },
      });
      const state = await operationsFixture(page);
      state.requests = [
        {
          ...native.view,
          id: "claude-question",
          sessionId: "fixture-session",
          source: "claude",
          status: "pending",
          revision: 1,
        },
      ];
      await page.goto("/sessions/fixture-session/chat");
      const panel = page.locator(".chat-container .native-requests");
      await expect(panel).toContainText("Which checks should run?");
      await expect(panel).not.toContainText("Where should they run?");
      await expect(panel).toContainText("Verify the visible behavior");
      await panel.getByLabel("Unit", { exact: true }).check();
      await panel.getByLabel("Browser", { exact: true }).check();
      expect(state.calls.some((call) => call.path.endsWith("/answer"))).toBe(false);
      await panel
        .getByRole("button", {
          name: locale === "de-DE" ? "Nächste Frage" : "Next question",
          exact: true,
        })
        .click();
      await expect(panel).toContainText("Where should they run?");
      await panel.getByLabel("Local", { exact: true }).check();
      await panel.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: test.info().outputPath("claude-questions.png") });
      await panel
        .getByRole("button", {
          name: locale === "de-DE" ? "Antwort senden" : "Send answer",
          exact: true,
        })
        .click();
      await expect(panel).toHaveCount(0);
      const answer = state.calls.find((call) => call.path.endsWith("/answer")).body;
      expect(answer).toEqual({
        expectedRevision: 1,
        answers: { q0: ["Unit", "Browser"], q1: ["Local"] },
      });
      expect(
        native.answer(answer).hookSpecificOutput.decision.updatedInput.answers,
      ).toEqual({
        "Which checks should run?": "Unit, Browser",
        "Where should they run?": "Local",
      });
    });
  });
}
