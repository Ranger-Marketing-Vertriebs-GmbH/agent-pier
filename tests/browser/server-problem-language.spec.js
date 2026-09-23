import { test, expect } from "@playwright/test";
import { claudeRequest } from "../../server/features/requests/claude-hook.js";
import { requestCopy } from "../../server/lib/i18n/de/requests.js";
import { messageIdentity } from "../../server/lib/i18n/message-identity.js";
import { operationsFixture } from "./operations-fixture.js";

// The server keeps its German problem text; the browser shows it by stable key.
for (const [locale, expected] of [
  ["en-GB", "Invalid native request or response."],
  ["de-DE", requestCopy.invalid],
]) {
  test.describe(locale, () => {
    test.use({ locale });
    test("a rejected Claude answer shows the server problem in the UI language", async ({
      page,
    }) => {
      const native = claudeRequest({
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              header: "Target",
              question: "Where should the checks run?",
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
      await page.route("**/api/sessions/*/requests/*/answer", (route) =>
        route.fulfill({
          status: 400,
          json: { error: requestCopy.invalid, ...messageIdentity(requestCopy.invalid) },
        }),
      );
      await page.goto("/sessions/fixture-session/chat");
      const panel = page.locator(".chat-container .native-requests");
      await expect(panel).toContainText("Where should the checks run?");
      await panel.getByLabel("Local", { exact: true }).check();
      await panel
        .getByRole("button", {
          name: locale === "de-DE" ? "Antwort senden" : "Send answer",
          exact: true,
        })
        .click();
      await expect(panel.getByRole("alert")).toHaveText(expected);
    });
  });
}
