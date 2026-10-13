import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { emit } from "../helpers/assistant-chat-fixture.js";
import { teamListFixture } from "../helpers/assistant-team-list-fixture.js";

// The lead's chat shows where teams started and ended as short notes; only what waits
// for the owner stays as a card. Team details live in Settings → Work → Teams.
const chat = baseURL + "/agents/home/chats/dinner";
const shots = process.env.TEAM_SETTINGS_SHOTS;
const viewports = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 1000 },
};
// Team notes as "<team>:<kind>", every other transcript entry as "message".
const logOrder = (page) =>
  page
    .getByRole("log")
    .evaluate((log) =>
      [...log.children].map((c) =>
        c.dataset.teamNote ? `${c.dataset.team}:${c.dataset.teamNote}` : "message",
      ),
    );
const fits = async (page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);

for (const [label, viewport] of Object.entries(viewports)) {
  test.describe(`team notes on ${label}`, () => {
    test.beforeEach(({ page }) => page.setViewportSize(viewport));

    test("the chat shows start and end notes in time order and no team cards", async ({
      page,
    }) => {
      await teamListFixture(page);
      await page.goto(chat);
      const log = page.getByRole("log");
      await expect(log.getByText("Team started: Research hosting vendors")).toBeVisible();
      expect(await logOrder(page)).toEqual([
        "old:started",
        "old:completed",
        "message",
        "research:started",
        "message",
        "research:completed",
        "message",
        "design:started",
        "message",
      ]);
      await expect(
        log.getByRole("link", { name: "Team completed: Research hosting vendors" }),
      ).toHaveAttribute("href", "/agents/home/settings?tab=work&team=research");
      // Started and running teams have no card; the proposal waits below the log.
      await expect(page.locator("details.assistant-team-card")).toHaveCount(0);
      await expect(page.locator(".assistant-team-card")).toHaveCount(1);
      await expect(page.locator(".assistant-team-card.awaiting")).toContainText(
        "Write launch copy",
      );
      await fits(page);
      if (shots) await page.screenshot({ path: `${shots}/chat-notes-${label}-en.png` });
    });

    test("a note opens the team in Settings → Work with the team expanded", async ({
      page,
    }) => {
      await teamListFixture(page);
      await page.goto(chat);
      await page
        .getByRole("log")
        .getByRole("link", { name: "Team started: Research hosting vendors" })
        .click();
      await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=work&team=research$/);
      const card = page.locator("#assistant-team-research");
      await expect(card).toHaveAttribute("open", "");
      await expect(card).toHaveAttribute("data-focused", "");
      await expect(card).toBeInViewport();
      await expect(card.locator(":scope > summary")).toBeFocused();
      await fits(page);
    });
  });
}

test("German notes use the German titles", async ({ page }) => {
  await teamListFixture(page, { language: "de" });
  await page.goto(chat);
  const log = page.getByRole("log");
  await expect(log.getByText("Team gestartet: Research hosting vendors")).toBeVisible();
  await expect(
    log.getByText("Team abgeschlossen: Research hosting vendors"),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Teams warten auf dich" })).toContainText(
    "Write launch copy",
  );
});

test("ended teams name their outcome", async ({ page }) => {
  const state = await teamListFixture(page);
  Object.assign(state.teams[2], {
    phase: "cancelled",
    status: "cancelled",
    finishedAt: new Date(Date.UTC(2026, 9, 13, 9, 1, 15)).toISOString(),
  });
  Object.assign(state.teams[1], { phase: "failed", status: "partial" });
  await page.goto(chat);
  const log = page.getByRole("log");
  await expect(log.getByText("Team cancelled: Draft the new design")).toBeVisible();
  await expect(
    log.getByText("Team partly completed: Research hosting vendors"),
  ).toBeVisible();
  expect((await logOrder(page)).at(-1)).toBe("design:cancelled");
});

test("a pending proposal stays actionable in the chat until it is decided", async ({
  page,
}) => {
  await page.setViewportSize(viewports.phone);
  const state = await teamListFixture(page, {
    activity: {
      home: {
        state: "waiting",
        reason: "approval",
        label: "teamActive.awaiting",
        pendingApprovals: 1,
        team: null,
      },
    },
  });
  await page.goto(chat);
  const strip = page.getByRole("button", { name: /Waiting for your approval · 1/ });
  await expect(strip).toBeEnabled();
  const proposal = page
    .getByRole("region", { name: "Teams waiting for you" })
    .getByRole("article", { name: "Write launch copy" });
  await page.locator(".assistant-transcript").evaluate((e) => (e.scrollTop = 0));
  await strip.click();
  await expect(proposal).toBeInViewport();
  await expect(proposal).toContainText("Writer · Copy");
  await proposal.getByRole("button", { name: "Decline team", exact: true }).click();
  await expect
    .poll(() => state.calls)
    .toContain("assistant-team-proposals/proposal/decision");
  await expect(proposal).toHaveCount(0);
  await expect(
    page.getByRole("log").getByText("Team proposal declined: Write launch copy"),
  ).toBeVisible();
});

test("a member's pending coding request stays in the chat", async ({ page }) => {
  const state = await teamListFixture(page);
  state.actions = [
    {
      id: "build",
      revision: 1,
      assistantId: "home",
      teamId: "design",
      memberName: "Designer",
      state: "awaiting_approval",
      projectName: "Website",
      pipelineName: "Build",
      payload: { action: "coding_start", task: "Build the start page" },
    },
  ];
  await page.goto(chat);
  await emit(page, { type: "change" });
  const requests = page.getByRole("region", {
    name: "Coding requests from the team · Draft the new design",
  });
  await expect(requests).toContainText("Requested by team member Designer");
  await expect(requests.getByRole("button", { name: "Approve action" })).toBeVisible();
});

test("a team link opens the lead's chat at the team's latest note", async ({ page }) => {
  await page.setViewportSize(viewports.phone);
  const state = await teamListFixture(page);
  const filler = (prefix, base) =>
    Array.from({ length: 30 }, (_, n) => ({
      id: `${prefix}-${n}`,
      role: n % 2 ? "user" : "assistant",
      text: `${prefix} message ${n} with enough words to wrap on a phone screen.`,
      timestamp: base + n,
    }));
  state.history.messages = [
    ...filler("Earlier", Date.UTC(2026, 9, 13, 9, 0, 0)),
    ...state.history.messages,
    ...filler("Later", Date.UTC(2026, 9, 13, 9, 2, 0)),
  ];
  await page.goto(baseURL + "/agents/home/teams/research");
  const note = page.locator('[data-team="research"][data-team-note="completed"]');
  await expect(note).toBeInViewport();
  await expect(note).toHaveClass(/focused/);
  const log = page.getByRole("log");
  await expect(log.getByText("Earlier message 0 ")).not.toBeInViewport();
  await expect(log.getByText("Later message 29 ")).not.toBeInViewport();
  // A later refresh keeps the reader there.
  await emit(page, { type: "change" });
  await expect(note).toBeInViewport();
});

test("member chats keep their link back to the lead's team", async ({ page }) => {
  await teamListFixture(page);
  await page.goto(baseURL + "/agents/designer/chats/designer-chat");
  const context = page.locator(".assistant-member-context");
  await expect(context).toContainText("Home assistant · Draft the new design");
  await expect(page.getByRole("log").locator(".assistant-team-note")).toHaveCount(0);
  await context.getByRole("button", { name: /Home assistant · Draft/ }).click();
  await expect(page).toHaveURL(/\/agents\/home\/teams\/design$/);
  await expect(
    page.locator('[data-team="design"][data-team-note="started"]'),
  ).toBeInViewport();
});
