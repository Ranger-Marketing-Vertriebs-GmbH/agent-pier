import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { emit } from "../helpers/assistant-chat-fixture.js";
import { at, teamListFixture } from "../helpers/assistant-team-list-fixture.js";

// A member whose outcome is unknown holds its team open until the owner reviews it,
// so the lead's chat keeps it with the approvals. Team notes follow a reader who
// is at the bottom.
const chat = baseURL + "/agents/home/chats/dinner";
const waiting = (count) => ({
  home: {
    state: "waiting",
    reason: "approval",
    label: "team.states.awaiting_approval",
    pendingApprovals: count,
    team: "active",
  },
});

for (const [label, viewport] of Object.entries({
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 1000 },
})) {
  test(`members with an unknown outcome stay in the lead's chat on ${label}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const state = await teamListFixture(page, { activity: waiting(2) });
    const designer = state.members.find((m) => m.id === "designer");
    Object.assign(designer, { phase: "provisioning_uncertain", conversationId: null });
    state.members.push({
      ...designer,
      id: "tester",
      assistantId: "tester",
      name: "Tester",
      phase: "uncertain",
      conversationId: "tester-chat",
    });
    state.teams.find((t) => t.id === "design").status = "uncertain";
    await page.goto(chat);
    const card = page
      .getByRole("region", { name: "Teams waiting for you" })
      .getByRole("article", { name: "Review needed: Draft the new design" });
    await expect(card).toHaveAttribute("data-pending", "");
    await expect(card).toContainText("Designer: Setup outcome unknown");
    await expect(card).toContainText("Tester: Outcome unknown");
    await expect(card.getByRole("link", { name: "Review Designer" })).toHaveAttribute(
      "href",
      "/agents/designer/settings",
    );
    await expect(card.getByRole("link", { name: "Review Tester" })).toHaveAttribute(
      "href",
      "/agents/tester/chats/tester-chat",
    );
    await page.locator(".assistant-transcript").evaluate((e) => (e.scrollTop = 0));
    await page.getByRole("button", { name: /Waiting for your approval · 2/ }).click();
    await expect(card).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await card.getByRole("link", { name: "Review Designer" }).click();
    await expect(page).toHaveURL(/\/agents\/designer\/settings$/);
    // Once reviewed, the entry leaves the chat.
    designer.phase = "failed";
    state.members.pop();
    await page.goto(chat);
    await expect(page.getByRole("log")).toBeVisible();
    await expect(page.locator(".assistant-team-approvals article")).toHaveCount(1);
    await expect(page.locator(".assistant-team-card.awaiting")).toBeVisible();
  });
}

test("a team link lands on its review entry; German names it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await teamListFixture(page, { language: "de" });
  state.members.find((m) => m.id === "designer").phase = "uncertain";
  await page.goto(baseURL + "/agents/home/teams/design");
  const card = page.getByRole("article", {
    name: "Prüfung nötig: Draft the new design",
  });
  await expect(card).toBeInViewport();
  await expect(card).toContainText("Designer: Ergebnis unklar");
  await expect(card.getByRole("link", { name: "Designer prüfen" })).toBeVisible();
});

test("a team note that arrives after the history keeps a bottom reader at the bottom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await teamListFixture(page);
  state.history.messages = [
    ...state.history.messages,
    ...Array.from({ length: 30 }, (_, n) => ({
      id: `later-${n}`,
      role: n % 2 ? "user" : "assistant",
      text: `Later message ${n} with enough words to wrap on a phone screen.`,
      timestamp: at(100 + n).getTime(),
    })),
  ];
  await page.goto(chat);
  const transcript = page.locator(".assistant-transcript");
  await expect(page.getByText("Later message 29 ")).toBeInViewport();
  // The team list answers after the history, so only the note changes the content.
  let slow = false;
  await page.route("**/api/assistants", async (route) => {
    if (slow) await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fallback();
  });
  slow = true;
  Object.assign(
    state.teams.find((t) => t.id === "design"),
    {
      phase: "completed",
      status: "completed",
      finishedAt: at(200).toISOString(),
    },
  );
  const history = page.waitForResponse((r) => r.url().endsWith("/messages"));
  await emit(page, { type: "change" });
  await history;
  const note = page.getByText("Team completed: Draft the new design");
  await expect(note).toBeVisible();
  await expect(note).toBeInViewport();
  expect(
    await transcript.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight),
  ).toBeLessThan(2);
});
