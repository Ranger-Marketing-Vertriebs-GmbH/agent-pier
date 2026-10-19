import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";

// The server sends German fallback labels; chat translates Claude's options by ID.
const approval = {
  id: "bash-permission",
  sessionId: "fixture-session",
  kind: "permission",
  source: "claude",
  revision: 1,
  status: "pending",
  subject: { tool: "Bash", command: "npm test", cwd: "/fixture/project" },
  options: [
    { id: "allow", label: "Einmal erlauben", scope: "once" },
    {
      id: "always",
      label: "Dauerhaft erlauben",
      description: "Bash(npm test:*)",
      scope: "persistent",
    },
    { id: "deny", label: "Ablehnen" },
  ],
};
const plan = {
  id: "plan-permission",
  sessionId: "fixture-session",
  kind: "permission",
  source: "claude",
  revision: 1,
  status: "pending",
  subject: {
    tool: "ExitPlanMode",
    plan: "# Rollout plan\n\n1. Add the hook\n2. **Test** it",
    cwd: "/fixture/project",
  },
  options: [
    { id: "acceptEdits", label: "x", scope: "session" },
    { id: "approve", label: "y", scope: "session" },
    { id: "keep", label: "z" },
  ],
};
const answers = (state) => state.calls.filter((call) => call.path.endsWith("/answer"));

for (const locale of ["en-GB", "de-DE"]) {
  const en = locale === "en-GB";
  test.describe(`Claude approvals ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 760 } });

    test("Always allow shows the rule it saves and sends that choice", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [approval];
      await page.goto("/sessions/fixture-session/chat");
      const card = page.locator(".native-request");
      await expect(card.locator(".native-request-rules pre")).toHaveText(
        "Bash(npm test:*)",
      );
      await expect(
        card.getByText(
          en
            ? "Always allow saves these rules for this Claude account, in every project:"
            : "Dauerhaft erlauben speichert diese Regeln für diesen Claude-Account, in allen Projekten:",
        ),
      ).toBeVisible();
      await expect(
        card.getByRole("button", { name: en ? "Allow once" : "Einmal erlauben" }),
      ).toBeVisible();
      await expect(
        card.getByRole("button", { name: en ? "Deny" : "Ablehnen", exact: true }),
      ).toBeVisible();
      await card
        .getByRole("button", { name: en ? "Always allow" : "Dauerhaft erlauben" })
        .click();
      await expect.poll(() => answers(state).length).toBe(1);
      expect(answers(state)[0]).toMatchObject({
        path: "/sessions/fixture-session/requests/bash-permission/answer",
        body: { expectedRevision: 1, choice: "always" },
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
    });

    test("an approval without proposed rules offers no Always allow", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [
        { ...approval, options: approval.options.filter((o) => o.id !== "always") },
      ];
      await page.goto("/sessions/fixture-session/chat");
      await expect(
        page.getByRole("button", { name: en ? "Allow once" : "Einmal erlauben" }),
      ).toBeVisible();
      await expect(page.locator(".native-request-rules")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: en ? "Always allow" : "Dauerhaft erlauben" }),
      ).toHaveCount(0);
    });

    test("a plan renders as Markdown with approve and keep-planning answers", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [plan];
      await page.goto("/sessions/fixture-session/chat");
      const card = page.locator(".native-request");
      await expect(card.locator("header strong")).toHaveText(
        en ? "Plan ready for review" : "Plan zur Freigabe",
      );
      const region = card.getByRole("region", {
        name: en ? "Proposed plan" : "Vorgeschlagener Plan",
      });
      await expect(region.getByRole("heading", { name: "Rollout plan" })).toBeVisible();
      await expect(region.locator("strong")).toHaveText("Test");
      await expect(card.locator("pre")).toHaveCount(0);
      for (const name of en
        ? ["Approve and auto-accept edits", "Approve and review each edit"]
        : [
            "Annehmen, Änderungen automatisch erlauben",
            "Annehmen, Änderungen einzeln freigeben",
          ])
        await expect(card.getByRole("button", { name })).toBeVisible();
      await card
        .getByRole("button", { name: en ? "Keep planning" : "Weiter planen" })
        .click();
      await expect.poll(() => answers(state).length).toBe(1);
      expect(answers(state)[0].body).toMatchObject({ choice: "keep" });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
    });
  });
}
