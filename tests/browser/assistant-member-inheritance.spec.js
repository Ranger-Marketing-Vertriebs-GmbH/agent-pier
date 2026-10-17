import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { fixture } from "./providers-fixture.js";

// A lead with one waiting proposal and one running task member, served by the routes
// the agent pages read; the Work tab save records its team half.
async function setup(page, { memberShellSsh = false } = {}) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const lead = {
    id: "home",
    name: "Home assistant",
    instructions: "Original",
    model: { connectionId: "router", modelId: "fixture-model" },
    capabilities: { webSearch: true, memory: true },
    shell: "approval",
    revision: 1,
    effectiveRevision: 1,
  };
  const member = {
    ...lead,
    id: "member-0",
    name: "Scout",
    teamMemberId: "member-0",
    parentAssistantId: "home",
    lifetime: "task",
    capabilities: undefined,
    shell: undefined,
    inherited: {
      capabilities: { webSearch: true, webFetch: false, memory: true },
      skills: ["weather"],
      shell: memberShellSsh ? "approval" : "off",
      ssh: memberShellSsh,
    },
  };
  const record = {
    id: "member-0",
    kind: "member",
    assistantId: "member-0",
    parentAssistantId: "home",
    teamId: "team",
    name: "Scout",
    role: "Research",
    assignment: "Look around",
    phase: "running",
    conversationId: "chat-0",
    revision: 1,
    lifetime: "task",
  };
  const proposal = {
    id: "proposal",
    kind: "team",
    parentAssistantId: "home",
    objective: "Plan a second assignment",
    phase: "awaiting_approval",
    members: [{ name: "Planner", role: "Plan", assignment: "Plan next step" }],
    memberShellSsh,
    revision: 1,
  };
  const policy = {
    revision: 1,
    autonomous: false,
    maxMembers: 4,
    runTimeoutMinutes: 10,
    memberShellSsh,
  };
  const posted = [];
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
        assistants: [lead, member],
        conversations: [
          { id: "parent-chat", assistantId: "home" },
          { id: "chat-0", assistantId: "member-0" },
        ],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        teams: [proposal],
        members: [record],
        policies: { home: policy },
        teamSettings: { revision: 1, hostMaxConcurrent: 8 },
      };
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages")) body = { messages: [], requests: [], stale: false };
    else if (p.endsWith("/work") && method === "PUT") {
      const input = route.request().postDataJSON();
      if (input.team) {
        posted.push(input.team);
        Object.assign(policy, input.team, { revision: policy.revision + 1 });
      }
      body = { access: { revision: 0 }, team: policy };
    } else if (p.endsWith("/access")) body = { revision: 0 };
    else if (p === "/api/assistant-workspace-catalog")
      body = { projects: [], pipelines: [] };
    await route.fulfill({ json: body });
  });
  return { posted, policy };
}

test("the Work tab saves whether team members may use shell and SSH", async ({
  page,
}) => {
  const { posted } = await setup(page);
  await page.goto(baseURL + settingsPath("work"));
  const toggle = page.getByLabel("Team members may use shell and SSH");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => posted.at(-1)?.memberShellSsh).toBe(true);
  await expect(toggle).toBeChecked();
});

test("the proposal card says what members inherit and warns about shell and SSH", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/chats/parent-chat");
  const card = page.locator("#assistant-team-proposal");
  await expect(card).toContainText("but no shell and no SSH");
  await expect(card.locator("[data-member-shell-ssh]")).toHaveCount(0);
});

test("a proposal approved with the setting shows the shell and SSH warning", async ({
  page,
}) => {
  await setup(page, { memberShellSsh: true });
  await page.goto(baseURL + "/agents/home/chats/parent-chat");
  const card = page.locator("#assistant-team-proposal");
  await expect(card.locator("[data-member-shell-ssh]")).toHaveText(
    "Members may use shell and SSH, at most with this agent's shell level and SSH grants. They also use its web access, skills, MCP servers, memory (read-only) and reminders.",
  );
});

test("a task member's capabilities show what it uses from its lead", async ({ page }) => {
  await setup(page, { memberShellSsh: true });
  await page.goto(baseURL + settingsPath("capabilities", undefined, "member-0"));
  const group = page.locator("#agent-inherited");
  await expect(group).toContainText("From the lead agent");
  await expect(
    group.locator(".list-row").filter({ hasText: "Search the web" }),
  ).toContainText("On");
  await expect(
    group.locator(".list-row").filter({ hasText: "Read web pages" }),
  ).toContainText("Off");
  await expect(
    group.locator(".list-row").filter({ hasText: "Shell access" }),
  ).toContainText("With approval");
});
