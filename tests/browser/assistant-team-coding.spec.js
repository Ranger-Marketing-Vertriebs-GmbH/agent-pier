import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
test("the team task shows a member's coding request with its exact approval and run link", async ({
  page,
}) => {
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
  const member = {
    id: "member",
    kind: "member",
    assistantId: "member",
    parentAssistantId: "home",
    teamId: "team",
    name: "Coder",
    role: "Developer",
    assignment: "Fix the failing build",
    phase: "completed",
    conversationId: "member-chat",
    revision: 1,
    lifetime: "task",
  };
  const team = {
    id: "team",
    kind: "team",
    parentAssistantId: "home",
    parentConversationId: "parent-chat",
    objective: "Fix the build",
    phase: "running",
    memberIds: ["member"],
    revision: 1,
  };
  let action = {
    id: "action",
    revision: 1,
    assistantId: "home",
    state: "awaiting_approval",
    projectName: "Demo project",
    pipelineName: "Build",
    requestedBy: "member",
    onBehalfOf: "home",
    teamId: "team",
    memberName: "Coder",
    payload: {
      action: "coding_start",
      projectId: "project",
      pipelineId: "pipeline",
      task: "Repair the CI configuration",
    },
  };
  const decisions = [];
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname;
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
        assistants: [
          parent,
          {
            ...parent,
            id: "member",
            name: "Coder",
            teamMemberId: "member",
            parentAssistantId: "home",
            lifetime: "task",
          },
        ],
        conversations: [
          { id: "parent-chat", assistantId: "home" },
          { id: "member-chat", assistantId: "member" },
        ],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        teams: [team],
        members: [member],
        policies: {
          home: { revision: 1, autonomous: true, maxMembers: 4, runTimeoutMinutes: 10 },
        },
        teamSettings: { revision: 1, hostMaxConcurrent: 8 },
      };
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages")) body = { messages: [], requests: [], stale: false };
    else if (p.endsWith("/conversations"))
      body = { id: "parent-chat", assistantId: "home" };
    else if (p === "/api/assistants/home/actions") body = { actions: [action] };
    else if (p === "/api/assistant-actions/action/decision") {
      decisions.push(route.request().postDataJSON());
      action = {
        ...action,
        state: "running",
        revision: 3,
        runId: "run",
        run: { id: "run", url: "/pipelines/runs/run", status: "running", nodes: [] },
      };
      body = action;
    }
    await route.fulfill({ json: body });
  });
  // A pending member request opens its team card in the parent chat.
  await page.goto(baseURL + "/agents/home/chats/parent-chat");
  await expect(
    page
      .getByRole("region", { name: "Coding requests from the team" })
      .getByRole("button", { name: "Approve action" }),
  ).toBeVisible();
  await page.goto(baseURL + "/agents/home/teams/team");
  const requests = page.getByRole("region", { name: "Coding requests from the team" });
  await expect(requests).toContainText("Requested by team member Coder");
  await expect(requests).toContainText("Demo project · Build");
  await expect(requests).toContainText("Repair the CI configuration");
  await expect(requests).toContainText(
    "Coding tasks from team members always need your approval",
  );
  await expect(requests.getByRole("button", { name: "Decline action" })).toBeVisible();
  await requests.getByRole("button", { name: "Approve action" }).click();
  await expect.poll(() => decisions).toEqual([{ revision: 1, decision: "approve" }]);
  await expect(
    requests.getByRole("link", { name: "Open run and artifacts" }),
  ).toHaveAttribute("href", "/pipelines/runs/run");
  await expect(requests.getByRole("button", { name: "Approve action" })).toHaveCount(0);
});
