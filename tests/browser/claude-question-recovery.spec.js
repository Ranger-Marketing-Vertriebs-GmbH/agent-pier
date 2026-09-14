import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
import { claudeRequest } from "../../server/features/requests/claude-hook.js";

const request = {
  ...claudeRequest({
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [
        {
          question: "Where should it go?",
          options: [{ label: "Local" }, { label: "Remote" }],
        },
      ],
    },
  }).view,
  id: "claude-recovery",
  sessionId: "fixture-session",
  revision: 1,
  status: "pending",
  source: "claude",
};

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`Claude question recovery ${locale}`, () => {
    test.use({ locale });
    test("polling a newer revision preserves the answer through a failed delivery", async ({
      page,
    }) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      state.requests = [request];
      await page.goto(baseURL + "/sessions/fixture-session/chat");
      await page
        .getByRole("radio", { name: en ? "Other answer" : "Andere Antwort", exact: true })
        .check();
      const input = page.getByRole("textbox", { name: /Where should it go/ });
      const text = "Keep this answer ü\nincluding its second line";
      await input.fill(text);
      const endpoint = "/sessions/fixture-session/requests/claude-recovery/answer";
      state.hold = endpoint;
      state.fail = endpoint;
      const submit = page.getByRole("button", {
        name: en ? "Send answer" : "Antwort senden",
        exact: true,
      });
      await submit.click();
      await expect.poll(() => typeof state.release).toBe("function");
      state.requests = [{ ...request, revision: 2, status: "responding" }];
      await expect(
        page.getByText(en ? "Delivering answer …" : "Antwort wird zugestellt …", {
          exact: true,
        }),
      ).toBeVisible();
      state.release();
      await expect(page.getByRole("alert")).toContainText("Fixture conflict");
      state.requests = [{ ...request, revision: 2 }];
      await expect(input).toHaveValue(text);
      await expect(submit).toBeEnabled();
      state.hold = state.fail = "";
      await submit.click();
      await expect(page.locator(".native-request")).toHaveCount(0);
      const calls = state.calls.filter((call) => call.path.endsWith("/answer"));
      expect(calls).toHaveLength(2);
      expect(calls[1].body).toEqual({ expectedRevision: 2, answers: { q0: [text] } });
    });

    test("legacy questions show terminal handoff instead of ineffective approval buttons", async ({
      page,
    }, testInfo) => {
      const en = locale === "en-GB";
      await page.setViewportSize({ width: 390, height: 600 });
      const state = await operationsFixture(page);
      state.requestIntegration = { reloadRequired: true };
      state.requests = [
        {
          ...request,
          kind: "permission",
          questions: undefined,
          presentation: "claudeLegacyQuestion",
          subject: { tool: "AskUserQuestion" },
          options: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" },
          ],
        },
      ];
      await page.goto(baseURL + "/sessions/fixture-session/chat");
      await expect(
        page.getByText(en ? "Answer required" : "Antwort erforderlich", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(
        0,
      );
      await expect(page.locator(".native-requests code")).toHaveText("/reload-plugins");
      await page.screenshot({ path: testInfo.outputPath("claude-legacy-question.png") });
      await page
        .getByRole("button", {
          name: en ? "Answer in terminal" : "Im Terminal beantworten",
          exact: true,
        })
        .click();
      expect(state.calls.filter((call) => call.path.endsWith("/answer"))).toHaveLength(0);
      expect(state.calls.filter((call) => call.path.endsWith("/handoff"))).toHaveLength(
        1,
      );
    });

    test("long native choices wrap and remain selectable on a short mobile screen", async ({
      page,
    }, testInfo) => {
      const en = locale === "en-GB";
      await page.setViewportSize({ width: 390, height: 500 });
      const state = await operationsFixture(page);
      const label = "LongNativeDestination".repeat(20);
      state.requests = [
        {
          ...request,
          questions: [
            {
              ...request.questions[0],
              options: [
                {
                  id: label,
                  label,
                  description: "A multiline description\nwith a second line",
                },
              ],
            },
          ],
        },
      ];
      await page.goto(baseURL + "/sessions/fixture-session/chat");
      await page.getByRole("radio", { name: label, exact: true }).check();
      expect(
        await page
          .locator(".native-question-body")
          .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("claude-long-question.png") });
      await page
        .getByRole("button", { name: en ? "Send answer" : "Antwort senden", exact: true })
        .click();
      await expect(page.locator(".native-request")).toHaveCount(0);
      expect(
        state.calls.find((call) => call.path.endsWith("/answer")).body.answers,
      ).toEqual({ q0: [label] });
    });

    test("an adapter update notice does not block ordinary chat", async ({ page }) => {
      const state = await operationsFixture(page);
      state.requestIntegration = { reloadRequired: true };
      await page.goto(baseURL + "/sessions/fixture-session/chat");
      await expect(page.locator(".native-requests code")).toHaveText("/reload-plugins");
      await expect(
        page.getByRole("textbox", {
          name: locale === "en-GB" ? "Message" : "Nachricht",
          exact: true,
        }),
      ).toBeEnabled();
    });
  });
}
