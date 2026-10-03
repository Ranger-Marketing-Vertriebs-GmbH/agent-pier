import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";

const permission = {
  id: "workflow-permission",
  sessionId: "fixture-session",
  kind: "permission",
  source: "claude",
  revision: 1,
  status: "pending",
  subject: {
    tool: "Workflow",
    description: "nightly-review: Review open PRs",
    cwd: "/fixture/project",
  },
  options: [
    { id: "allow", label: "Einmal erlauben", scope: "once" },
    { id: "deny", label: "Ablehnen" },
  ],
};
const handoffs = (state) => state.calls.filter((call) => call.path.endsWith("/handoff"));
const answers = (state) => state.calls.filter((call) => call.path.endsWith("/answer"));

for (const locale of ["de-DE", "en-GB"]) {
  const en = locale === "en-GB";
  const notice = en
    ? "Approval is waiting in the terminal."
    : "Freigabe wartet im Terminal.";
  test.describe(`Claude terminal permissions ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 700 } });

    test("the terminal takes over a pending tool approval without approving it", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [permission];
      await page.goto("/sessions/fixture-session/terminal");
      await expect.poll(() => handoffs(state).length).toBe(1);
      expect(handoffs(state)[0]).toMatchObject({
        path: "/sessions/fixture-session/requests/workflow-permission/handoff",
        body: { expectedRevision: 1 },
      });
      expect(answers(state)).toHaveLength(0);
      // This tab released it itself, so chat shows no redundant notice.
      state.requestNotice = { id: permission.id, reason: "terminal" };
      await page
        .locator(".terminal-topbar")
        .getByRole("button", { name: "Chat", exact: true })
        .click();
      await expect
        .poll(() => state.calls.filter((call) => call.path.endsWith("/requests")).length)
        .toBeGreaterThan(3);
      await expect(page.getByText(notice, { exact: true })).toHaveCount(0);
    });

    test("chat shows the approval summary and announces it once it moves to the terminal", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [permission];
      await page.goto("/sessions/fixture-session/chat");
      await expect(
        page.getByText("nightly-review: Review open PRs", { exact: true }),
      ).toBeVisible();
      expect(handoffs(state)).toHaveLength(0);
      // Another device released it, or the hook reached its lifetime.
      state.requests = [];
      state.requestNotice = { id: permission.id, reason: "terminal" };
      await expect(page.getByText(notice, { exact: true })).toBeVisible();
      const input = page.getByRole("textbox", {
        name: en ? "Message" : "Nachricht",
        exact: true,
      });
      await expect(input, "the notice never blocks chat").toBeEnabled();
      await page
        .getByRole("button", { name: en ? "Dismiss" : "Ausblenden", exact: true })
        .click();
      await expect(page.getByText(notice, { exact: true })).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      // A newer notice is shown again and opens the terminal on request.
      state.requestNotice = { id: "second-permission", reason: "terminal" };
      await expect(page.getByText(notice, { exact: true })).toBeVisible();
      await page
        .locator(".native-requests")
        .getByRole("button", {
          name: en ? "Open terminal" : "Terminal öffnen",
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/\/sessions\/fixture-session\/terminal/);
      expect(answers(state)).toHaveLength(0);
    });

    test("answering in the terminal from chat hands off without a duplicate notice", async ({
      page,
    }) => {
      const state = await operationsFixture(page, { tool: "claude" });
      state.requests = [permission];
      await page.goto("/sessions/fixture-session/chat");
      await page
        .getByRole("button", {
          name: en ? "Answer in terminal" : "Im Terminal beantworten",
          exact: true,
        })
        .click();
      await expect.poll(() => handoffs(state).length).toBe(1);
      await expect(page).toHaveURL(/\/sessions\/fixture-session\/terminal/);
      state.requestNotice = { id: permission.id, reason: "terminal" };
      await page
        .locator(".terminal-topbar")
        .getByRole("button", { name: "Chat", exact: true })
        .click();
      await expect
        .poll(() => state.calls.filter((call) => call.path.endsWith("/requests")).length)
        .toBeGreaterThan(3);
      await expect(page.getByText(notice, { exact: true })).toHaveCount(0);
      expect(answers(state)).toHaveLength(0);
    });
  });
}
