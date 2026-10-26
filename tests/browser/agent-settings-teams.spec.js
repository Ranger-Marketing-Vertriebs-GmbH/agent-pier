import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { teamListFixture, teamRecords } from "../helpers/assistant-team-list-fixture.js";

// Agent settings › Team › Teams: every team of the lead with members, status, results and
// the immediate actions that used to live in the chat's team cards.
const work = baseURL + settingsPath("team");
const shots = process.env.TEAM_SETTINGS_SHOTS;
const viewports = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 1000 },
};
const group = (page, name = "Teams") =>
  page.locator("#agent-teams").filter({ has: page.getByRole("heading", { name }) });
const fits = async (page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);

for (const [label, viewport] of Object.entries(viewports)) {
  test.describe(`teams group on ${label}`, () => {
    test.beforeEach(({ page }) => page.setViewportSize(viewport));

    test("lists the lead's teams with members, status and results", async ({ page }) => {
      await teamListFixture(page);
      await page.goto(work);
      const teams = group(page);
      const filter = teams.getByRole("radiogroup", { name: "Show teams" });
      await expect(filter.getByRole("radio", { name: "Active (3)" })).toBeChecked();
      await expect(filter.getByRole("radio", { name: "Archived (1)" })).toBeVisible();
      // Newest first; the proposal stays actionable here as well.
      await expect(teams.locator(".assistant-team-card")).toHaveCount(3);
      await expect(teams.locator(".assistant-team-card strong").first()).toHaveText(
        "Write launch copy",
      );
      await expect(
        teams.getByRole("button", { name: "Approve team", exact: true }),
      ).toBeVisible();
      const research = teams.locator("#assistant-team-research");
      await expect(research.locator(":scope > summary")).toContainText(
        "Completed · 1 member",
      );
      await research.locator(":scope > summary").click();
      await expect(research).toContainText(
        "Started because you wrote: “Plan the relaunch with a team”",
      );
      await expect(research).toContainText("Results summarized in the chat");
      await research.getByText("Report", { exact: true }).click();
      await expect(research).toContainText("Vendor B is cheapest.");
      await expect(research.getByRole("link", { name: "Show in chat" })).toHaveAttribute(
        "href",
        "/agents/home/teams/research",
      );
      await expect(
        research.getByRole("button", { name: "Archive", exact: true }),
      ).toBeVisible();
      const design = teams.locator("#assistant-team-design");
      await expect(design.locator(":scope > summary")).toContainText(
        "Working · 1 member",
      );
      await design.locator(":scope > summary").click();
      await expect(
        design.getByRole("button", { name: "Stop team", exact: true }),
      ).toBeVisible();
      await expect(design.getByRole("button", { name: "Archive" })).toHaveCount(0);
      await fits(page);
      if (shots) {
        await teams.evaluate((e) => e.scrollIntoView({ block: "start" }));
        await page.screenshot({ path: `${shots}/settings-teams-${label}-en.png` });
      }
      await design.getByRole("button", { name: /^Designer/ }).click();
      await expect(page).toHaveURL(/\/agents\/designer\/chats\/designer-chat$/);
    });

    test("archive moves a team to Archived and restore brings it back", async ({
      page,
    }) => {
      const state = await teamListFixture(page);
      await page.goto(work);
      const teams = group(page);
      const research = teams.locator("#assistant-team-research");
      await research.locator(":scope > summary").click();
      await research.getByRole("button", { name: "Archive", exact: true }).click();
      await expect.poll(() => state.calls).toContain("assistant-teams/research/archive");
      await expect(research).toHaveCount(0);
      const archived = teams.getByRole("radio", { name: "Archived (2)" });
      await archived.check();
      await expect(teams.locator(".assistant-team-card")).toHaveCount(2);
      await teams.locator("#assistant-team-research > summary").click();
      await teams
        .locator("#assistant-team-research")
        .getByRole("button", { name: "Restore", exact: true })
        .click();
      await expect.poll(() => state.calls).toContain("assistant-teams/research/restore");
      await expect(teams.getByRole("radio", { name: "Archived (1)" })).toBeChecked();
      await expect(teams.locator("#assistant-team-research")).toHaveCount(0);
      await teams.getByRole("radio", { name: "Active (3)" }).check();
      await expect(teams.locator("#assistant-team-research")).toBeVisible();
      await fits(page);
    });
  });
}

test("a deep link to an archived team opens the Archived side with it expanded", async ({
  page,
}) => {
  await page.setViewportSize(viewports.phone);
  await teamListFixture(page);
  await page.goto(baseURL + "/agents/home/settings?tab=team&team=old");
  const teams = group(page);
  await expect(teams.getByRole("radio", { name: "Archived (1)" })).toBeChecked();
  const card = teams.locator("#assistant-team-old");
  await expect(card).toHaveAttribute("open", "");
  await expect(card).toBeInViewport();
  await expect(card.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await expect(card).toContainText("Auditor");
});

test("an unknown team in the link leaves the list as it is", async ({ page }) => {
  await teamListFixture(page);
  await page.goto(baseURL + "/agents/home/settings?tab=team&team=missing");
  const teams = group(page);
  await expect(teams.getByRole("radio", { name: "Active (3)" })).toBeChecked();
  await expect(teams.locator("details[open]")).toHaveCount(0);
});

test("the group speaks German", async ({ page }) => {
  await teamListFixture(page, { language: "de" });
  await page.goto(baseURL + "/agents/home/settings?tab=team&team=research");
  const teams = group(page);
  await expect(teams.getByRole("radio", { name: "Aktiv (3)" })).toBeChecked();
  await expect(teams.getByRole("radio", { name: "Archiviert (1)" })).toBeVisible();
  const research = teams.locator("#assistant-team-research");
  await expect(research).toContainText("Ergebnisse im Chat zusammengefasst");
  await expect(research.getByRole("link", { name: "Im Chat zeigen" })).toBeVisible();
  await expect(
    research.getByRole("button", { name: "Archivieren", exact: true }),
  ).toBeVisible();
});

test("a lead without teams says so", async ({ page }) => {
  await teamListFixture(page, { teams: [], members: [] });
  await page.goto(work);
  await expect(group(page)).toContainText("This agent has not started a team yet.");
  await expect(group(page).getByRole("radiogroup")).toHaveCount(0);
});

test("a member's pending coding request opens its team card", async ({ page }) => {
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
  await page.goto(work);
  const design = group(page).locator("#assistant-team-design");
  // A pending request opens its team.
  await expect(design).toHaveAttribute("open", "");
  const requests = design.getByRole("region", { name: "Coding requests from the team" });
  await expect(requests).toContainText("Requested by team member Designer");
  await expect(requests.getByRole("button", { name: "Approve action" })).toBeVisible();
});

test("a link to a proposal focuses its card", async ({ page }) => {
  await teamListFixture(page);
  await page.goto(baseURL + "/agents/home/settings?tab=team&team=proposal");
  const card = group(page).getByRole("article", { name: "Write launch copy" });
  await expect(card).toBeFocused();
  await expect(card).toBeInViewport();
});

test("switching sides after a team link does not pull the reader back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await teamListFixture(page);
  await page.goto(baseURL + "/agents/home/settings?tab=team&team=research");
  const teams = group(page);
  const summary = teams.locator("#assistant-team-research > summary");
  await expect(summary).toBeFocused();
  await teams.getByRole("radio", { name: "Archived (1)" }).check();
  const active = teams.getByRole("radio", { name: "Active (3)" });
  await active.check();
  await expect(summary).toBeVisible();
  await expect(summary).not.toBeFocused();
  // Focus stays where the click left it: on the radio, or on the page in Safari on
  // macOS, which does not focus a clicked radio.
  expect(
    await active.evaluate(
      (radio) =>
        document.activeElement === radio || document.activeElement === document.body,
    ),
  ).toBe(true);
  await expect(active).toBeInViewport();
});

test("a shortened report and answer say so and link to the member's chat", async ({
  page,
}) => {
  const { teams } = teamRecords();
  // The list carries an excerpt; the card loads the whole report when opened.
  Object.assign(teams.find((t) => t.id === "research").resultBatch[0], {
    text: "Vendor B is",
    truncated: true,
    cut: true,
  });
  await teamListFixture(page, {
    teams,
    requests: [
      {
        id: "ask-long",
        kind: "lead-request",
        revision: 1,
        type: "question",
        parentAssistantId: "home",
        memberId: "researcher",
        memberAssistantId: "researcher",
        memberName: "Researcher",
        leadName: "Home assistant",
        text: "Compare every vendor in detail.",
        phase: "completed",
        createdAt: "2026-10-13T09:00:00.000Z",
        // Too large for OpenClaw to serve: no text at all, still not missing.
        answerCut: true,
      },
    ],
  });
  await page.route(/\/api\/assistant-teams\/research\/reports\/researcher$/, (route) =>
    route.fulfill({
      json: { memberId: "researcher", text: "Vendor B is cheapest.", cut: true },
    }),
  );
  await page.goto(baseURL + "/agents/home/settings?tab=team&team=research");
  const research = group(page).locator("#assistant-team-research");
  await research.getByText("Report", { exact: true }).click();
  await expect(research).toContainText("Vendor B is cheapest.");
  await expect(research).toContainText(
    "Shortened – the whole report is in the member’s chat.",
  );
  const chat = "/agents/researcher/chats/researcher-chat";
  await expect(research.getByRole("link", { name: "Open chat" })).toHaveAttribute(
    "href",
    chat,
  );
  await page.getByRole("radio", { name: "Finished (1)" }).click();
  const card = page.locator(".lead-request-card");
  await card.getByText("Answer", { exact: true }).click();
  await expect(card).toContainText("Shortened – the whole text is in the member’s chat.");
  await card.getByRole("link", { name: "Open chat" }).click();
  await expect(page).toHaveURL(new RegExp(`${chat}$`));
});
