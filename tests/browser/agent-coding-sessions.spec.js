import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { fixture } from "./providers-fixture.js";
import { hubFixture } from "./projects-fixture.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

const putPath = /^\/api\/assistant-project-access\/([^/]+)\/([^/]+)$/;

// Coding sessions per project: Projects > Agents and Agents > Access > Projects
// (AGENTPIER-225).
test("English project Agents tab ticks coding sessions and keeps the coding grant", async ({
  page,
}) => {
  const agent = { id: "home", name: "Home", revision: 1, coding: false, folder: "none" };
  const puts = [];
  await hubFixture(page, {
    intercept: async (route, url, method) => {
      if (url.pathname === "/api/assistants") {
        await route.fulfill({ json: { assistants: [agent], conversations: [] } });
        return true;
      }
      if (
        method === "GET" &&
        /^\/api\/assistant-project-access\/m1$/.test(url.pathname)
      ) {
        await route.fulfill({ json: { agents: [agent], members: [] } });
        return true;
      }
      if (method !== "PUT" || !putPath.test(url.pathname)) return false;
      const body = route.request().postDataJSON();
      puts.push(body);
      Object.assign(agent, {
        revision: agent.revision + 1,
        coding: body.coding,
        folder: body.coding ? body.folder : "none",
        sessions: body.sessions === true,
      });
      await route.fulfill({ json: { ...agent } });
      return true;
    },
  });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/projects/m1?tab=agents");
  const card = page.locator('[data-project-agent="home"]');
  const sessions = card.getByLabel("Coding sessions", { exact: true });
  await expect(sessions).not.toBeChecked();
  await expect(
    card.getByText(/start and steer its own coding sessions in this project/),
  ).toBeVisible();
  await sessions.check();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({
    coding: true,
    folder: "none",
    sessions: true,
    expected: { coding: false, folder: "none" },
  });
  await expect(sessions).toBeChecked();
  await expect(
    card.getByLabel("May start coding sessions in this project"),
  ).toBeChecked();
  await sessions.uncheck();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1]).toMatchObject({
    coding: true,
    sessions: false,
    expected: { coding: true, folder: "none", sessions: true },
  });
});

test("English Access tab switches coding sessions for a granted project and saves them", async ({
  page,
}) => {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  let policy = {
    revision: 0,
    projectIds: [],
    projectFiles: {},
    sessionProjectIds: [],
    pipelineIds: [],
    memoryWrite: false,
    autonomous: false,
    publish: false,
    sshAccesses: [],
  };
  const saves = [];
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const url = new URL(route.request().url()),
      method = route.request().method();
    let body = {};
    if (url.pathname === "/api/assistants")
      body = {
        assistants: [
          {
            id: "home",
            name: "Home",
            instructions: "Help",
            model: { connectionId: "router", modelId: "model" },
            revision: 1,
            effectiveRevision: 1,
          },
        ],
        conversations: [],
        policies: {
          home: { revision: 0, autonomous: false, maxMembers: 4, runTimeoutMinutes: 10 },
        },
        models: [{ id: "router", name: "Router", available: true }],
      };
    else if (url.pathname === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (url.pathname === "/api/assistant-workspace-catalog")
      body = {
        // Older rows of the same folder (restarts, git init) are listed only once.
        projects: [
          { id: "project", name: "Demo project", path: "/Users/me/demo" },
          ...["older", "oldest"].map((id) => ({
            id,
            name: "Demo project",
            path: "/Users/me/demo",
            duplicateOf: "project",
            pipelineWork: false,
          })),
        ],
        pipelines: [],
        sshHosts: [],
      };
    else if (url.pathname.endsWith("/work") && method === "PUT") {
      const input = route.request().postDataJSON();
      saves.push(input.access);
      policy = { ...policy, ...input.access, revision: policy.revision + 1 };
      body = {
        access: policy,
        team: { revision: 0, autonomous: false, maxMembers: 4, runTimeoutMinutes: 10 },
        removedProjectIds: [],
      };
    } else if (url.pathname.endsWith("/access")) body = policy;
    else if (url.pathname.endsWith("/actions")) body = { actions: [] };
    else if (url.pathname === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    else return route.fallback();
    await route.fulfill({ json: body });
  });
  await page.goto(baseURL + settingsPath("access", "projects"));
  await page.getByLabel("Demo project", { exact: true }).check();
  await page.getByRole("button", { name: "Back to Access" }).click();
  const sessions = page.getByRole("switch", {
    name: "Coding sessions for Demo project",
  });
  await expect(sessions).not.toBeChecked();
  await sessions.check();
  await saveBar(page).getByRole("button", { name: "Save agent", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].projectIds).toEqual(["project"]);
  expect(saves[0].sessionProjectIds).toEqual(["project"]);
  // Revoking the project drops the grant with it.
  await page.getByRole("button", { name: "Revoke Demo project" }).click();
  await saveBar(page).getByRole("button", { name: "Save agent", exact: true }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toMatchObject({ projectIds: [], sessionProjectIds: [] });
});

test("English session list and header mark a session an agent started", async ({
  page,
}) => {
  await fixture(page, {
    session: {
      id: "agent-session",
      name: "Agent task",
      accountId: "local-claude",
      tool: "claude",
      status: "running",
      cwd: "/fixture/demo",
      startedBy: { kind: "agent", assistantId: "home", name: "Home" },
    },
  });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/sessions/agent-session/chat");
  await expect(
    page.locator(".session-item", { hasText: "Agent task" }).locator("small"),
  ).toContainText("· Agent Home");
  await expect(page.locator(".session-title")).toContainText("Started by agent Home");
});

// The agent escalated a permission prompt of its session (AGENTPIER-225): the chat
// card shows the live prompt and answers it through the session's own endpoint.
test("English agent chat answers an escalated session prompt in its card", async ({
  page,
}) => {
  const prompt = {
    id: "p1",
    sessionId: "agent-session",
    kind: "permission",
    source: "codex",
    status: "pending",
    revision: 2,
    options: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
    subject: { tool: "shell", description: "Remove the build folder" },
  };
  await chatFixture(page, {
    actions: [
      {
        id: "escalation-1",
        assistantId: "home",
        revision: 1,
        state: "awaiting_approval",
        createdAt: "2026-10-27T08:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        payload: {
          action: "session_request",
          sessionId: "agent-session",
          promptId: "p1",
          sessionName: "Codex · demo",
          kind: "permission",
          title: "shell",
          note: "It wants to delete build output.",
        },
      },
    ],
  });
  let requests = [prompt];
  const answers = [];
  await page.route(/\/api\/sessions\/agent-session\/requests/, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST") {
      expect(url.pathname).toBe("/api/sessions/agent-session/requests/p1/answer");
      answers.push(route.request().postDataJSON());
      requests = [];
    }
    await route.fulfill({ json: { requests } });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const card = page.locator("[data-session-escalation]");
  await expect(card.locator(".assistant-approval-head strong")).toHaveText(
    "Question from a coding session",
  );
  await expect(card.locator(".assistant-approval-head small")).toHaveText("Codex · demo");
  await expect(card.getByText("Note from Home assistant")).toBeVisible();
  await expect(card.getByText("It wants to delete build output.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Deny" })).toBeVisible();
  await card.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => answers.length).toBe(1);
  expect(answers[0]).toMatchObject({ expectedRevision: 2 });
  await expect(card.getByText("Answered", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Open session" }).click();
  await expect(page).toHaveURL(/\/sessions\/agent-session\/chat$/);
});
