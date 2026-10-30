import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

const preview = {
  people: 3,
  members: { temporary: 2, permanent: 1 },
  work: {
    turns: 1,
    teams: 0,
    members: 2,
    requests: 0,
    coding: 1,
    goals: 0,
    approvals: 3,
  },
};

// The preview and restart routes of the agent's main chats, like the server.
async function restartRoutes(page, state) {
  await page.route(/\/api\/assistants\/home\/main-chat-restart$/, async (route) => {
    if (route.request().method() === "POST") {
      state.restarts++;
      return route.fulfill({
        json: {
          restartedAt: "2026-10-30T10:00:00.000Z",
          chats: [{ userId: "owner", from: "old", to: "new" }],
          work: preview.work,
          members: { ended: ["a", "b"], restarted: ["c"] },
        },
      });
    }
    state.previews++;
    return route.fulfill({ json: preview });
  });
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("restart main chat needs the acknowledgement and reports success", async ({
      page,
    }) => {
      await chatFixture(page);
      const state = { previews: 0, restarts: 0 };
      await restartRoutes(page, state);
      await page.goto(baseURL + settingsPath("overview"));

      const group = page.getByRole("region", { name: "Danger zone" });
      await group.getByRole("button", { name: /Restart main chat/ }).click();
      const dialog = page.getByRole("dialog", {
        name: "Restart the main chat of “Home assistant”?",
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("not checked")).toBeVisible();
      await expect(dialog.getByText(/3 main chats/)).toBeVisible();
      await expect(dialog.getByText(/2 temporary members end/)).toBeVisible();
      await expect(dialog.getByText(/1 permanent member starts fresh/)).toBeVisible();
      await expect(dialog.getByText("3 pending approvals")).toBeVisible();
      // A kind with nothing running gets no line.
      await expect(dialog.getByText(/work goal/)).toHaveCount(0);

      const confirm = dialog.getByRole("button", {
        name: "Restart main chats and stop work",
      });
      await expect(confirm).toBeDisabled();
      await dialog
        .getByRole("checkbox", { name: "I understand this cannot be undone" })
        .check();
      await expect(confirm).toBeEnabled();
      if (label === "phone")
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      await confirm.click();
      await expect.poll(() => state.restarts).toBe(1);
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("status")).toHaveText(
        "Main chats restarted. The previous ones are under archived chats.",
      );
    });
  });
}

test("cancel restarts nothing", async ({ page }) => {
  await chatFixture(page);
  const state = { previews: 0, restarts: 0 };
  await restartRoutes(page, state);
  await page.goto(baseURL + settingsPath("overview"));
  await page
    .getByRole("region", { name: "Danger zone" })
    .getByRole("button", { name: /Restart main chat/ })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(state.restarts).toBe(0);
});

test("a team member's settings have no danger zone", async ({ page }) => {
  await chatFixture(page, {
    assistants: [chatAssistant({ teamMemberId: "m1", lifetime: "permanent" })],
  });
  await restartRoutes(page, { previews: 0, restarts: 0 });
  await page.goto(baseURL + settingsPath("overview"));
  await expect(page.getByRole("region", { name: "At a glance" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Danger zone" })).toHaveCount(0);
});
