import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

const chat = baseURL + "/agents/home/chats/dinner";
const long = {
  messages: Array.from({ length: 30 }, (_, n) => ({
    id: `m${n}`,
    role: n % 2 ? "user" : "assistant",
    text: `Message ${n} with enough words to wrap across a couple of lines on a phone.`,
  })),
  requests: [],
  stale: false,
};
const action = (id) => ({
  id,
  revision: 1,
  state: "awaiting_approval",
  projectName: "Website",
  pipelineName: "Build",
  payload: {
    action: "coding_start",
    title: `Fix ${id}`,
    task: "Repair the contact form",
  },
});
const waiting = (pendingApprovals) => ({
  home: {
    state: "waiting",
    reason: "approval",
    label: "teamActive.awaiting",
    pendingApprovals,
    team: null,
  },
});

test.describe("approval strip", () => {
  test("counts server approvals and jumps to the first pending card", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, {
      history: long,
      activity: waiting(2),
      actions: [action("own-1"), action("own-2")],
    });
    await page.goto(chat);
    const strip = page.getByRole("button", { name: /Waiting for your approval · 2/ });
    await expect(strip).toBeEnabled();
    await expect(strip).toHaveCSS("height", "40px");
    const card = page.locator(".assistant-approval-card").first();
    await expect(card).toHaveCSS("border-top-color", "rgba(244, 154, 88, 0.2)");
    await page.locator(".assistant-transcript").evaluate((e) => (e.scrollTop = 0));
    await expect(card).not.toBeInViewport();
    await strip.click();
    await expect(card).toBeInViewport();
    expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
    await expect(
      page
        .getByRole("region", { name: "Waiting for your approval" })
        .getByRole("button", { name: "Approve action", exact: true })
        .first(),
    ).toBeVisible();
  });

  test("enables the jump once a card arrives after the strip mounted", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await chatFixture(page, { history: long, activity: waiting(1) });
    await page.goto(chat);
    const strip = page.getByRole("button", { name: /Waiting for your approval · 1/ });
    await expect(strip).toBeDisabled();
    state.actions = [action("late-1")];
    await emit(page, { type: "change" });
    const card = page.locator(".assistant-approval-card").first();
    await expect(card).toBeVisible();
    await expect(strip).toBeEnabled();
    await page.locator(".assistant-transcript").evaluate((e) => (e.scrollTop = 0));
    await strip.click();
    await expect(card).toBeInViewport();
  });

  test("is absent without approvals and in member chats", async ({ page }) => {
    await chatFixture(page, {
      assistants: [
        chatAssistant(),
        chatAssistant({
          id: "member-0",
          name: "Research lead",
          teamMemberId: "member-0",
        }),
      ],
      conversations: [
        { id: "dinner", assistantId: "home" },
        { id: "member-chat", assistantId: "member-0" },
      ],
      activity: { "member-0": waiting(1).home },
    });
    await page.goto(chat);
    await expect(page.locator(".assistant-approval-strip")).toHaveCount(0);
    await page.goto(baseURL + "/agents/member-0/chats/member-chat");
    await expect(page.locator(".assistant-header")).toBeVisible();
    await expect(page.locator(".assistant-approval-strip")).toHaveCount(0);
  });
});
