import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
async function setup(page) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const parent = {
    id: "home",
    name: "Home assistant",
    instructions: "Original",
    model: { connectionId: "router", modelId: "fixture-model" },
    revision: 1,
    effectiveRevision: 1,
  };
  const members = Array.from({ length: 4 }, (_, n) => ({
    id: `member-${n}`,
    kind: "member",
    assistantId: `member-${n}`,
    parentAssistantId: "home",
    teamId: "team",
    name: `Reviewer ${n + 1}`,
    role: "Research",
    assignment: `Review topic ${n + 1}`,
    phase: "running",
    conversationId: `chat-${n}`,
    revision: 1,
    lifetime: "task",
    inheritedRevision: 1,
  }));
  const team = {
    id: "team",
    kind: "team",
    parentAssistantId: "home",
    objective: "Review the project",
    phase: "running",
    memberIds: members.map((m) => m.id),
    revision: 1,
  };
  const proposal = {
    id: "proposal",
    kind: "team",
    parentAssistantId: "home",
    objective: "Plan a second assignment",
    phase: "awaiting_approval",
    members: [{ name: "Planner", role: "Plan", assignment: "Plan next step" }],
    revision: 1,
  };
  const assistants = [
    parent,
    ...members.map((m) => ({
      ...parent,
      id: m.id,
      name: m.name,
      teamMemberId: m.id,
      parentAssistantId: "home",
      lifetime: "task",
    })),
  ];
  const policy = { revision: 1, autonomous: false, maxMembers: 4, runTimeoutMinutes: 10 };
  const teamSettings = { revision: 1, hostMaxConcurrent: 8 };
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class {
      constructor(url) {
        if (url !== "/api/assistant-events") return new NativeEventSource(url);
        window.assistantTestStream = this;
      }
      close() {}
    };
  });
  const teams = [team, proposal];
  const posted = [];
  const history = {
    messages: [{ id: "reply", role: "assistant", text: "Research in progress" }],
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname,
      method = route.request().method();
    if (
      [
        "/api/assistant-channels",
        "/api/assistant-speech",
        "/api/assistant-runtime/updates",
      ].includes(p)
    )
      return route.fallback();
    if (p === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    let body = {};
    if (p === "/api/assistants")
      body = {
        assistants,
        conversations: [
          { id: "parent-chat", assistantId: "home" },
          ...members
            .filter((m) => m.conversationId)
            .map((m) => ({ id: m.conversationId, assistantId: m.id })),
        ],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        teams,
        members,
        policies: { home: policy },
        teamSettings,
      };
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages")) {
      body = {
        messages: history.messages,
        requests: [],
        stale: false,
      };
      if (method === "POST") posted.push(route.request().postDataJSON());
    } else if (p.endsWith("/conversations")) {
      const id = p.split("/")[3];
      body = {
        id: members.find((m) => m.id === id)?.conversationId || "parent-chat",
        assistantId: id,
      };
    } else if (p.endsWith("/decision")) {
      proposal.phase = "declined";
      body = proposal;
    } else if (p.endsWith("/team-policy") || p === "/api/assistant-team-settings") {
      const input = route.request().postDataJSON(),
        current = p.endsWith("/team-policy") ? policy : teamSettings;
      posted.push(input);
      if (input.revision !== current.revision)
        return route.fulfill({
          status: 409,
          json: { error: "The data has changed. Please reload." },
        });
      Object.assign(current, input, { revision: current.revision + 1 });
      body = current;
    } else if (p.endsWith("/archive") || p.endsWith("/restore")) {
      const archivedAt = p.endsWith("/archive") ? "2026-10-08" : null;
      members[0].archivedAt = archivedAt;
      assistants[1].archivedAt = archivedAt;
      body = members[0];
    } else if (method === "PATCH" && p.startsWith("/api/assistants/")) {
      const input = route.request().postDataJSON(),
        agent = assistants.find((a) => a.id === p.split("/")[3]);
      posted.push(input);
      if (input.confirmInstructions) agent.instructionsSource = "owner";
      body = agent;
    } else if (p.endsWith("/promote")) {
      members[0].lifetime = "permanent";
      assistants[1].lifetime = "permanent";
      assistants[1].instructionsSource = "model";
      body = members[0];
    }
    await route.fulfill({ json: body });
  });
  return { members, posted, policy, teamSettings, teams, assistants, history };
}
test("nested members open directly, retain drafts and show independent settings", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + "/agents");
  await expect(page.locator(".assistant-card")).toHaveCount(1);
  await expect(page.locator(".assistant-sidebar-member")).toHaveCount(0);
  await page.getByRole("button", { name: /Show team members/ }).click();
  await expect(page.locator(".assistant-sidebar-member")).toHaveCount(4);
  await page
    .locator("aside")
    .getByRole("button", { name: /^Reviewer 1, / })
    .click();
  await expect(page).toHaveURL(/\/agents\/member-0\/chats\/chat-0$/);
  await expect(page.getByText("Review topic 1", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Keep member draft");
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await expect(
    page.getByText("Created by Home assistant · inherited revision 1"),
  ).toBeVisible();
  await expect(page.getByText("Task-bound member", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Keep member draft",
  );
  await page.screenshot({
    path: ".cache/assistant-teams-desktop-en.png",
    fullPage: true,
  });
});
test("approval and one-request permission remain accessible on mobile", async ({
  page,
}) => {
  const { posted } = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/agents/home/chats/parent-chat");
  await expect(
    page.getByRole("button", { name: "Approve team", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Decline team", exact: true }).click();
  await page.getByLabel("Allow a team for this message").check();
  await page.getByLabel("Message", { exact: true }).fill("Review this project");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => posted[0]?.teamAllowed).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({ path: ".cache/assistant-teams-mobile-en.png", fullPage: true });
});
test("completed member keeps its chat through archive, restore and promotion; parent policy is explicit", async ({
  page,
}) => {
  const { members, posted } = await setup(page);
  members[0].phase = "completed";
  await page.goto(baseURL + "/agents/member-0/settings");
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(
    page.locator("aside").getByRole("button", { name: /^Reviewer 1, / }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page
    .getByRole("button", { name: "Keep as permanent agent", exact: true })
    .click();
  await expect(page.getByText("Permanent agent", { exact: true })).toBeVisible();
  const notice = page.getByRole("note").filter({
    hasText: "Generated by the team lead — review before use.",
  });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Mark as reviewed", exact: true }).click();
  await expect
    .poll(() => posted.at(-1))
    .toEqual({
      confirmInstructions: true,
      revision: 1,
    });
  await expect(notice).toHaveCount(0);
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/member-0\/chats\/chat-0$/);
  await page.goto(baseURL + "/agents/home/settings");
  await page.getByLabel("Allow teams without asking each time").check();
  await page.getByRole("button", { name: "Save team settings", exact: true }).click();
  await expect.poll(() => posted.at(-1)?.autonomous).toBe(true);
  await page.screenshot({ path: ".cache/assistant-team-policy-en.png", fullPage: true });
});

async function refreshFromEvent(page) {
  const refreshed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/assistants",
  );
  await page.evaluate(() =>
    window.assistantTestStream.onmessage({ data: JSON.stringify({ type: "change" }) }),
  );
  await refreshed;
}
test("policy drafts cannot borrow a newer revision to restore revoked authority", async ({
  page,
}) => {
  const { policy, posted } = await setup(page);
  policy.autonomous = true;
  await page.goto(baseURL + "/agents/home/settings");
  await expect(page.getByLabel("Allow teams without asking each time")).toBeChecked();
  policy.autonomous = false;
  policy.revision = 2;
  await refreshFromEvent(page);
  await page.getByRole("button", { name: "Save team settings", exact: true }).click();
  await expect.poll(() => posted.at(-1)?.revision).toBe(1);
  await expect(
    page.getByText("The data has changed. Please reload.", { exact: true }),
  ).toBeVisible();
  expect(policy.autonomous).toBe(false);
});
test("members without a conversation expose recovery through sidebar and parent team", async ({
  page,
}) => {
  const { members } = await setup(page);
  members[0].phase = "provisioning_uncertain";
  members[0].conversationId = null;
  await page.goto(baseURL + "/agents/home/chats/parent-chat");
  await page
    .locator(".assistant-team-card")
    .filter({ hasText: "Review the project" })
    .locator("summary")
    .click();
  await page
    .locator(".assistant-team-members")
    .getByRole("button", { name: "Reviewer 1", exact: true })
    .click({ timeout: 3000 });
  await expect(page).toHaveURL(/\/agents\/member-0\/settings$/);
  await expect(
    page.getByRole("button", {
      name: "Restart service and acknowledge uncertainty",
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(baseURL + "/agents");
  await page.getByRole("button", { name: /Show team members/ }).click();
  await page
    .locator("aside")
    .getByRole("button", { name: /^Reviewer 1, / })
    .click({ timeout: 3000 });
  await expect(page).toHaveURL(/\/agents\/member-0\/settings$/);
});
test("host settings initialize from server and retain the draft revision across refreshes", async ({
  page,
}) => {
  const { teamSettings, posted } = await setup(page);
  teamSettings.revision = 7;
  teamSettings.hostMaxConcurrent = 12;
  await page.goto(baseURL + "/settings/assistants");
  const capacity = page.getByLabel("Concurrent members on this host");
  await expect(capacity).toHaveValue("12");
  await capacity.fill("16");
  teamSettings.revision = 8;
  teamSettings.hostMaxConcurrent = 20;
  await refreshFromEvent(page);
  await page.getByRole("button", { name: "Save team settings", exact: true }).click();
  await expect.poll(() => posted.at(-1)?.revision).toBe(7);
  await expect(
    page.getByText("The data has changed. Please reload.", { exact: true }),
  ).toBeVisible();
  expect(teamSettings.hostMaxConcurrent).toBe(20);
  await page.reload();
  await expect(capacity).toHaveValue("20");
  await capacity.fill("24");
  await page.getByRole("button", { name: "Save team settings", exact: true }).click();
  await expect.poll(() => teamSettings.revision).toBe(9);
  await capacity.fill("28");
  await page.getByRole("button", { name: "Save team settings", exact: true }).click();
  await expect.poll(() => teamSettings.revision).toBe(10);
  expect(teamSettings.hostMaxConcurrent).toBe(28);
});

test("historical assignments group same-named members with direct chat access", async ({
  page,
}) => {
  const { members, teams, assistants } = await setup(page);
  teams.push({
    ...teams[0],
    id: "older-team",
    objective: "Review last release",
    phase: "completed",
    status: "partial",
  });
  const older = {
    ...members[0],
    id: "older-member",
    assistantId: "older-member",
    teamId: "older-team",
    conversationId: "older-chat",
    assignment: "Check last release notes",
    phase: "completed",
  };
  members.push(older);
  assistants.push({ ...assistants[1], id: older.assistantId, teamMemberId: older.id });
  await page.goto(baseURL + "/agents");
  await page.getByRole("button", { name: /Show team members/ }).click();
  const sidebar = page.locator("aside");
  const group = sidebar.getByRole("group", { name: "Review last release", exact: true });
  await expect(group).toBeVisible();
  await expect(
    group.getByRole("button", { name: /^Reviewer 1, / }),
  ).toHaveAccessibleDescription("Check last release notes");
  const launch = await page
    .getByRole("button", { name: "New session", exact: true })
    .boundingBox();
  expect(launch.height).toBeGreaterThanOrEqual(40);
  const content = await page
    .locator(".assistant-chats-group > .sidebar-group-content")
    .boundingBox();
  const sessions = await page.locator(".sessions-group").boundingBox();
  expect(content.y + content.height).toBeLessThanOrEqual(sessions.y + 1);
  await expect(
    group.getByText("Check last release notes", { exact: true }),
  ).toBeVisible();
  await expect(group.getByText("Partially successful", { exact: true })).toBeVisible();
  await group.getByRole("button", { name: /^Reviewer 1, / }).click();
  await expect(page).toHaveURL(/\/agents\/older-member\/chats\/older-chat$/);
  await page.screenshot({ path: ".cache/assistant-team-history-en.png", fullPage: true });
});
test("member settings identify model and instruction overrides independently", async ({
  page,
}) => {
  const { members } = await setup(page);
  members[0].overrides = { model: true, instructions: false };
  await page.goto(baseURL + "/agents/member-0/settings");
  await expect(
    page.getByText("Model: changed since creation", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Instructions: as created", { exact: true })).toBeVisible();
  members[0].overrides = { model: false, instructions: true };
  await refreshFromEvent(page);
  await expect(page.getByText("Model: as created", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Instructions: changed since creation", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: ".cache/assistant-team-overrides-en.png",
    fullPage: true,
  });
});
test("team cards show aggregate uncertainty and partial completion", async ({ page }) => {
  const { teams } = await setup(page);
  teams[0].status = "uncertain";
  await page.goto(baseURL + "/agents/home/chats/parent-chat");
  const summary = page
    .locator(".assistant-team-card summary")
    .filter({ hasText: "Review the project" });
  await expect(summary).toContainText("Outcome unknown");
  teams[0].status = "stopping";
  await refreshFromEvent(page);
  await expect(summary).toContainText("Stopping");
  teams[0].status = "partial";
  teams[0].phase = "failed";
  await refreshFromEvent(page);
  await expect(summary).toContainText("Partially successful");
  await summary.click();
  await expect(page.getByRole("button", { name: "Stop team", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
});
test("a team task link from Telegram opens the parent chat with that team expanded", async ({
  page,
}) => {
  const { teams } = await setup(page);
  teams[0].parentConversationId = "parent-chat";
  await page.goto(baseURL + "/agents/home/teams/team");
  const card = page
    .locator(".assistant-team-card")
    .filter({ hasText: "Review the project" });
  await expect(card).toHaveAttribute("open", "");
  await expect(page.getByRole("log").getByText("Research in progress")).toBeVisible();
  await expect(page).toHaveURL(/\/agents\/home\/teams\/team$/);
});
test("a team started by a plain-language owner request shows the quoted words", async ({
  page,
}) => {
  const { teams } = await setup(page);
  teams[0].parentConversationId = "parent-chat";
  teams[0].ownerRequestQuote = "build a team that reviews the project";
  await page.goto(baseURL + "/agents/home/teams/team");
  const card = page
    .locator(".assistant-team-card")
    .filter({ hasText: "Review the project" });
  await expect(card).toContainText(
    "Started because you wrote: “build a team that reviews the project”",
  );
  await expect(
    page.locator(".assistant-team-card").filter({ hasText: "Plan a second" }),
  ).not.toContainText("Started because");
});
test("a finished team shows its synthesis turn as a note and an owner stop as cancelled", async ({
  page,
}) => {
  const { teams, history } = await setup(page);
  teams[0].status = "cancelled";
  teams[0].phase = "cancelled";
  history.messages = [
    { id: "event", role: "event", event: "team-result" },
    { id: "reply", role: "assistant", text: "Here is the summary" },
  ];
  await page.goto(baseURL + "/agents/home/chats/parent-chat");
  const log = page.getByRole("log");
  await expect(
    log.getByText("Team results received. The agent is summarizing them.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(log.locator(".assistant-message.user")).toHaveCount(0);
  await expect(
    page
      .locator(".assistant-team-card summary")
      .filter({ hasText: "Review the project" }),
  ).toContainText("Cancelled");
});
