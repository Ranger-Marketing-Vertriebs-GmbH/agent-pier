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

  test("German action buttons fit a 320px card without widening it", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await chatFixture(page, { language: "de", actions: [action("narrow")] });
    await page.goto(chat);
    const card = page.locator(".assistant-approval-card");
    await expect(card.getByRole("button", { name: "Aktion freigeben" })).toBeVisible();
    const box = await card.boundingBox();
    expect(Math.round(box.x + box.width)).toBe(304);
    for (const button of await card.locator(".assistant-card-actions .button").all())
      expect(await button.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  });

  // A member's count holds only its own requests (team coding requests count for the
  // lead), and those wait in its own chat, so the strip shows there too.
  test("is absent without approvals and counts a member's own ones", async ({ page }) => {
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
    await expect(
      page.getByRole("button", { name: /Waiting for your approval · 1/ }),
    ).toBeVisible();
  });
});

const memberRecord = (overrides = {}) => ({
  id: "member-0",
  kind: "member",
  teamId: "team",
  parentAssistantId: "home",
  assistantId: "member-0",
  name: "Research lead",
  role: "Research",
  assignment: "Compare the three biggest vendors",
  lifetime: "task",
  phase: "running",
  conversationId: "member-chat",
  ...overrides,
});
const runningTeam = (overrides = {}) => ({
  id: "team",
  revision: 1,
  parentAssistantId: "home",
  parentConversationId: "dinner",
  objective: "Prepare the website relaunch",
  phase: "running",
  members: [],
  memberIds: ["member-0"],
  ...overrides,
});
const memberSetup = (overrides = {}) => ({
  assistants: [
    chatAssistant(),
    chatAssistant({
      id: "member-0",
      name: "Research lead",
      teamMemberId: "member-0",
      teamId: "team",
      parentAssistantId: "home",
      lifetime: "task",
    }),
  ],
  conversations: [
    { id: "dinner", assistantId: "home" },
    { id: "member-chat", assistantId: "member-0" },
  ],
  members: [memberRecord()],
  teams: [runningTeam()],
  activity: {
    "member-0": {
      state: "working",
      reason: "member",
      label: "team.states.running",
      pendingApprovals: 0,
      team: null,
    },
  },
  ...overrides,
});

test.describe("member chat", () => {
  test("context strip links back, stops the member and the composer is one row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await chatFixture(page, memberSetup());
    await page.goto(baseURL + "/agents/member-0/chats/member-chat");
    const strip = page.locator(".assistant-member-context");
    await expect(strip).toContainText("Home assistant · Prepare the website relaunch");
    await expect(strip).toContainText("Compare the three biggest vendors");
    const status = page.locator(".assistant-header-status");
    await expect(status).toContainText("Working");
    await expect(status).toContainText("· Research · openai/gpt-4.1-mini");
    // Member chats offer only files behind "+" (no team permission).
    await expect(page.getByRole("button", { name: "Options", exact: true })).toHaveCount(
      1,
    );
    await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute(
      "placeholder",
      "Message Research lead …",
    );
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await strip.getByRole("button", { name: "Stop member", exact: true }).click();
    await expect
      .poll(() => state.calls)
      .toContain("/api/assistant-team-members/member-0/stop");
    await strip.getByRole("button", { name: /Home assistant · Prepare/ }).click();
    await expect(page).toHaveURL(/\/agents\/home\/teams\/team$/);
  });

  test("permanent or orphaned members show only role and assignment", async ({
    page,
  }) => {
    await chatFixture(
      page,
      memberSetup({
        members: [memberRecord({ lifetime: "permanent", phase: "completed" })],
      }),
    );
    await page.goto(baseURL + "/agents/member-0/chats/member-chat");
    const strip = page.locator(".assistant-member-context");
    await expect(strip).toContainText("Research");
    await expect(strip.getByRole("button")).toHaveCount(0);
  });
});

test.describe("team proposal", () => {
  test("waits in the chat with full-width buttons; running teams have no card", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, {
      ...memberSetup(),
      teams: [
        runningTeam(),
        runningTeam({
          id: "proposal",
          objective: "Plan a second launch",
          phase: "awaiting_approval",
          memberIds: [],
          members: [{ name: "Reviewer", role: "Review", assignment: "Check results" }],
        }),
      ],
    });
    await page.goto(chat);
    const proposal = page.locator(".assistant-team-card.awaiting");
    await expect(proposal).toContainText("Reviewer · Review");
    const [approve, decline] = await Promise.all([
      proposal.getByRole("button", { name: "Approve team", exact: true }).boundingBox(),
      proposal.getByRole("button", { name: "Decline team", exact: true }).boundingBox(),
    ]);
    expect(Math.abs(approve.width - decline.width)).toBeLessThanOrEqual(1);
    expect(approve.height).toBe(44);
    await expect(page.locator(".assistant-team-card")).toHaveCount(1);
    await expect(page.getByText("Prepare the website relaunch")).toHaveCount(0);
  });
});
