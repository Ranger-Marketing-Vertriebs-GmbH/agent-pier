import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { fixture } from "./providers-fixture.js";

// A lead with one waiting proposal and one running task member, served by the routes
// the agent pages read; the Work tab save records its team half.
async function setup(page, { memberShellSsh = false, permanent = false } = {}) {
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
    lifetime: permanent ? "permanent" : "task",
    grants: { webSearch: true, memory: true },
    grantLog: [
      {
        at: "2026-10-17T08:00:00.000Z",
        by: "lead",
        edited: ["model"],
        model: {
          from: { connection: "Router", model: "Fixture" },
          to: { connection: "Local", model: "Qwen" },
        },
      },
      {
        at: "2026-10-17T09:00:00.000Z",
        by: "lead",
        edited: ["role", "instructions"],
        replaced: "entry-1",
      },
      { at: "2026-10-17T10:00:00.000Z", by: "lead", granted: ["browser"] },
    ],
  };
  // The lead's later shell grant for the member, waiting for the owner.
  const grantAction = {
    id: "grant-1",
    assistantId: "home",
    revision: 1,
    state: "awaiting_approval",
    createdAt: "2026-10-17T10:00:00.000Z",
    expiresAt: Date.now() + 3600000,
    payload: {
      action: "member_grant",
      approval: true,
      memberId: "member-0",
      memberName: "Scout",
      teamId: "team",
      grants: { shell: "approval" },
    },
  };
  const decisions = [];
  const proposal = {
    id: "proposal",
    kind: "team",
    parentAssistantId: "home",
    objective: "Plan a second assignment",
    phase: "awaiting_approval",
    members: [
      {
        name: "Planner",
        role: "Plan",
        assignment: "Plan next step",
        grants: { memory: true, webSearch: true, webFetch: true },
        model: { connectionId: "local", modelId: "qwen" },
        modelLabel: { connection: "Local", model: "Qwen" },
      },
      {
        name: "Runner",
        role: "Run",
        assignment: "Run the checks",
        grants: memberShellSsh
          ? { webSearch: true, shell: "approval" }
          : { browser: true },
      },
    ],
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
    // The replaced text loads only when the owner opens the history entry.
    else if (p === "/api/assistant-team-members/member-0/replaced/entry-1")
      body = { text: "Owner text that was replaced." };
    else if (p.endsWith("/messages"))
      body = {
        messages:
          p.includes("member-0") || p.includes("chat-0")
            ? [
                {
                  id: "member-grant:note",
                  role: "event",
                  event: "member-grant",
                  memberName: "Scout",
                  by: "lead",
                  granted: ["browser"],
                  mcpServers: 0,
                  state: "completed",
                  timestamp: Date.now() - 1000,
                  runId: null,
                },
                {
                  id: "member-promote:note",
                  role: "event",
                  event: "member-promote",
                  memberName: "Scout",
                  timestamp: Date.now() - 200,
                  runId: null,
                },
                {
                  id: "member-summarise:now",
                  role: "event",
                  event: "member-summarise",
                  memberName: "Scout",
                  when: "now",
                  timestamp: Date.now() - 300,
                  runId: null,
                },
                {
                  id: "member-summarise:after",
                  role: "event",
                  event: "member-summarise",
                  memberName: "Scout",
                  when: "after_task",
                  timestamp: Date.now() - 250,
                  runId: null,
                },
                {
                  id: "member-update:note",
                  role: "event",
                  event: "member-update",
                  memberName: "Scout",
                  previousName: "Finder",
                  edited: ["name", "role"],
                  timestamp: Date.now() - 500,
                  runId: null,
                },
                {
                  id: "member-update:model",
                  role: "event",
                  event: "member-update",
                  memberName: "Scout",
                  edited: ["model"],
                  model: {
                    from: { connection: "Router", model: "Fixture" },
                    to: { connection: "Local", model: "Qwen" },
                  },
                  timestamp: Date.now() - 400,
                  runId: null,
                },
              ]
            : [],
        requests: [],
        stale: false,
      };
    else if (p === "/api/assistants/member-0/memory/files")
      body = {
        files: [
          { name: "memory/2026-10-17.md", size: 13, modifiedAt: "2026-10-17T10:00:00Z" },
        ],
      };
    else if (p === "/api/assistants/member-0/memory")
      body = {
        name: "MEMORY.md",
        content: "Scout's own facts",
        missing: false,
        hash: null,
      };
    else if (p === "/api/assistants/home/actions")
      body = { actions: grantAction.state === "awaiting_approval" ? [grantAction] : [] };
    else if (p === "/api/assistant-actions/grant-1/decision") {
      decisions.push(route.request().postDataJSON());
      grantAction.state = "completed";
      body = grantAction;
    } else if (p.endsWith("/work") && method === "PUT") {
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
  return { posted, policy, decisions };
}

test("the Team tab saves whether team members may use shell and SSH", async ({
  page,
}) => {
  const { posted } = await setup(page);
  await page.goto(baseURL + settingsPath("team"));
  const toggle = page.getByLabel("Team members may use shell and SSH");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await saveBar(page).getByRole("button", { name: "Save agent", exact: true }).click();
  await expect.poll(() => posted.at(-1)?.memberShellSsh).toBe(true);
  await expect(toggle).toBeChecked();
});

test("the proposal card lists each member's grants", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/chats/parent-chat");
  const card = page.locator("#assistant-team-proposal");
  const grants = card.locator("[data-grants]");
  await expect(grants.nth(0)).toHaveText(
    "Gets: Lead's memory (read only), Web search, Web pages",
  );
  await expect(grants.nth(1)).toHaveText("Gets: Browser");
  await expect(card.locator("[data-member-shell-ssh]")).toHaveCount(0);
  // A model the lead chose shows by its names; a member without one follows the lead.
  await expect(card.locator("[data-model]")).toHaveText([
    "Model: Qwen (Local), chosen by the lead agent",
  ]);
});

test("a member granted shell is highlighted with the warning", async ({ page }) => {
  await setup(page, { memberShellSsh: true });
  await page.goto(baseURL + "/agents/home/chats/parent-chat");
  const card = page.locator("#assistant-team-proposal");
  await expect(card.locator("[data-shell-ssh]")).toHaveText(
    "⚠ Gets: Web search, Shell (With approval)",
  );
  await expect(card.locator("[data-member-shell-ssh]")).toHaveText(
    "Members marked with a warning get shell or SSH, at most at this agent's level and on its hosts. They work unattended, and content they read can steer them.",
  );
});

test("a later shell grant waits for the owner's approval in the lead's chat", async ({
  page,
}) => {
  const { decisions } = await setup(page, { memberShellSsh: true });
  await page.goto(baseURL + "/agents/home/chats/parent-chat");
  const card = page.locator("[data-member-grant-approval]");
  await expect(card).toContainText("The lead agent wants to give Scout:");
  await expect(card).toContainText("⚠ Shell (With approval)");
  await card.getByRole("button", { name: "Approve grant", exact: true }).click();
  await expect.poll(() => decisions.at(-1)?.decision).toBe("approve");
});

test("a task member's Access tab shows what its lead granted and when", async ({
  page,
}) => {
  await setup(page, { memberShellSsh: true });
  await page.goto(baseURL + settingsPath("access", undefined, "member-0"));
  const group = page.locator("#agent-granted");
  await expect(group).toContainText("Granted by the lead agent");
  await expect(
    group.locator(".list-row").filter({ hasText: "Search the web" }),
  ).toContainText("On");
  await expect(
    group.locator(".list-row").filter({ hasText: "Read web pages" }),
  ).toContainText("Off");
  await expect(
    group.locator(".list-row").filter({ hasText: "Shell access" }),
  ).toContainText("With approval");
  await expect(group.locator("[data-grant-log] li").first()).toContainText(
    "the lead agent granted Browser",
  );
});

test("the member's chat notes a grant from its lead", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/member-0/chats/chat-0");
  await expect(page.locator("[data-member-grant]")).toHaveText(
    "Scout was granted Browser by its lead agent",
  );
});

test("a lead's edit of a member shows in its chat and in its history", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + "/agents/member-0/chats/chat-0");
  const notes = page.locator("[data-member-update]");
  await expect(notes.filter({ hasText: "Finder" })).toHaveText(
    "The lead agent changed Finder's name, role; it is now called Scout",
  );
  // A model change names both models.
  await expect(notes.filter({ hasText: "moved" })).toHaveText(
    "The lead agent moved Scout from Fixture (Router) to Qwen (Local)",
  );
  await page.goto(baseURL + settingsPath("access", undefined, "member-0"));
  const log = page.locator("[data-grant-log] li").nth(1);
  await expect(log).toContainText(
    "the lead agent changed the member's role, instructions",
  );
  await log.getByText("Instructions it replaced").click();
  await expect(log.locator("pre")).toHaveText("Owner text that was replaced.");
  await expect(
    page.locator("[data-grant-log] li").filter({ hasText: "moved" }),
  ).toContainText(
    "the lead agent moved the member from Fixture (Router) to Qwen (Local)",
  );
});

test("a permanent member's overview shows its lead's edits and the replaced instructions", async ({
  page,
}) => {
  await setup(page, { permanent: true });
  // The member card with its history moved from Profile to Overview.
  await page.goto(baseURL + settingsPath("", undefined, "member-0"));
  const log = page.locator("[data-grant-log] li").nth(1);
  await expect(log).toContainText(
    "the lead agent changed the member's role, instructions",
  );
  await log.getByText("Instructions it replaced").click();
  await expect(log.locator("pre")).toHaveText("Owner text that was replaced.");
});

test("a lead's promotion of a member shows in its chat", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/member-0/chats/chat-0");
  await expect(page.locator("[data-member-promote]")).toHaveText(
    "The lead agent kept Scout as a permanent agent",
  );
});

test("a lead's summary of a member's chat shows in its chat", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/member-0/chats/chat-0");
  await expect(page.locator('[data-member-summarise="now"]')).toHaveText(
    "The lead agent had Scout's chat summarised",
  );
  await expect(page.locator('[data-member-summarise="after_task"]')).toHaveText(
    "The lead agent asked for Scout's chat to be summarised once its current task ends",
  );
});

test("the owner opens a task member's own memory from its capabilities", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("capabilities", undefined, "member-0"));
  await page.getByRole("link", { name: /^Own memory/ }).click();
  await expect(page.getByText("memory/2026-10-17.md").first()).toBeAttached();
});
