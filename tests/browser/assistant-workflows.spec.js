import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
test("English project grants and exact action approvals link existing coding runs on desktop and mobile", async ({
  page,
}) => {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  let policy = {
      revision: 0,
      projectIds: [],
      pipelineIds: [],
      memoryWrite: false,
      autonomous: false,
      publish: false,
    },
    decision;
  const decisions = [];
  let cancellations = 0;
  let action = {
    id: "action",
    revision: 1,
    assistantId: "home",
    state: "awaiting_approval",
    projectName: "Demo project",
    pipelineName: "Build",
    payload: {
      action: "coding_start",
      projectId: "project",
      pipelineId: "pipeline",
      task: "Implement the requested feature",
      baseBranch: "main",
    },
  };
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
        projects: [{ id: "project", name: "Demo project" }],
        pipelines: [{ id: "pipeline", name: "Build" }],
      };
    else if (url.pathname.endsWith("/access")) {
      if (method === "PUT") policy = { ...route.request().postDataJSON(), revision: 1 };
      body = policy;
    } else if (url.pathname.endsWith("/actions")) body = { actions: [action] };
    else if (url.pathname.endsWith("/decision")) {
      decision = route.request().postDataJSON();
      decisions.push(decision);
      action =
        decision.decision === "review"
          ? { ...action, state: "reviewed", revision: 8 }
          : {
              ...action,
              state: "running",
              revision: 2,
              run: {
                id: "run",
                url: "/pipelines/runs/run",
                status: "awaiting-human",
                nodes: [],
              },
            };
      body = action;
    } else if (url.pathname.endsWith("/cancel") && method === "POST") {
      cancellations++;
      action = { ...action, state: "unknown", revision: 7 };
      body = action;
    } else if (url.pathname === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    else return route.fallback();
    await route.fulfill({ json: body });
  });
  await page.goto(baseURL + "/agents/home/settings");
  await page.getByLabel("Demo project", { exact: true }).check();
  await page.getByLabel("Build", { exact: true }).check();
  await page.getByLabel("Allow proposals to update project memory").check();
  await page.getByRole("button", { name: "Save project access" }).click();
  await expect.poll(() => policy.projectIds).toEqual(["project"]);
  expect(policy.autonomous).toBe(false);
  await expect(
    page.getByText("Implement the requested feature", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve action", exact: true }).click();
  await expect.poll(() => decision).toEqual({ revision: 1, decision: "approve" });
  await expect(page.getByRole("link", { name: "Review required step" })).toHaveAttribute(
    "href",
    "/pipelines/runs/run",
  );
  await page.getByRole("button", { name: "Stop coding task", exact: true }).click();
  await expect(page.getByText(/The outcome is uncertain/)).toBeVisible();
  await page
    .getByRole("button", { name: "Mark outcome as checked", exact: true })
    .click();
  await expect(page.getByText("Outcome checked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark outcome as checked" })).toHaveCount(
    0,
  );
  expect(decisions).toEqual([
    { revision: 1, decision: "approve" },
    { revision: 7, decision: "review" },
  ]);
  expect(cancellations).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Projects and coding tasks" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({
    path: ".cache/assistant-workflows-mobile-en.png",
    fullPage: true,
  });
});
test("model connection choices explain unsupported providers and protocols without undefined labels", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/assistant-feature", fulfillEnabledAssistantFeature);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route("**/api/assistants", (route) =>
    route.fulfill({
      json: {
        assistants: [],
        conversations: [],
        models: [
          {
            id: "missing",
            name: "Private provider",
            available: false,
            reason: "credentialsRequired",
          },
          {
            id: "protocol",
            name: "Responses only",
            available: false,
            reason: "unsupportedProtocol",
          },
          {
            id: "other",
            name: "Future provider",
            available: false,
            reason: "futureReason",
          },
          { id: "available", name: "Local endpoint", available: true },
        ],
      },
    }),
  );
  await page.goto(baseURL + "/agents");
  await page.getByRole("button", { name: "New agent" }).click();
  const choices = page.getByLabel("Model connection");
  await expect(choices.locator('option[value="missing"]')).toHaveText(
    "Private provider · Credentials required",
  );
  await expect(choices.locator('option[value="protocol"]')).toHaveText(
    "Responses only · Endpoint protocol not supported",
  );
  await expect(choices.locator('option[value="protocol"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(choices.locator('option[value="other"]')).toHaveText("Future provider");
  await choices.selectOption("available");
  await expect(choices).toHaveValue("available");
});
test("pending coding approvals of the agent are decided in the chat", async ({
  page,
}) => {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const decisions = [];
  const coding = (id, extra) => ({
    id,
    revision: 1,
    assistantId: "home",
    state: "awaiting_approval",
    projectName: "Demo project",
    pipelineName: "Build",
    payload: { action: "coding_start", task: `Task ${id}`, baseBranch: "main" },
    ...extra,
  });
  let actions = [
    coding("own"),
    coding("member", { teamId: "team", requestedBy: "m1", memberName: "Reviewer" }),
    coding("done", { state: "completed" }),
  ];
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname;
    let body = {};
    if (p === "/api/assistants")
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
        conversations: [{ id: "chat", assistantId: "home" }],
        models: [{ id: "router", name: "Router", available: true }],
      };
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages")) body = { messages: [], requests: [], stale: false };
    else if (p.endsWith("/actions")) body = { actions };
    else if (p.endsWith("/decision")) {
      const id = p.split("/")[3];
      decisions.push([id, route.request().postDataJSON()]);
      actions = actions.map((a) =>
        a.id === id ? { ...a, state: "declined", revision: 2 } : a,
      );
      body = actions.find((a) => a.id === id);
    } else if (p === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    else return route.fallback();
    await route.fulfill({ json: body });
  });
  await page.goto(baseURL + "/agents/home/chats/chat");
  const approvals = page.getByRole("region", { name: "Waiting for your approval" });
  await expect(approvals.getByText("Task own", { exact: true })).toBeVisible();
  // Team members' requests are decided in their open team card.
  await expect(approvals.getByText("Task member", { exact: true })).toHaveCount(0);
  await expect(approvals.getByText("Task done", { exact: true })).toHaveCount(0);
  await approvals
    .locator("article")
    .filter({ hasText: "Task own" })
    .getByRole("button", { name: "Decline action", exact: true })
    .click();
  await expect
    .poll(() => decisions)
    .toEqual([["own", { revision: 1, decision: "decline" }]]);
  await expect(approvals.getByText("Task own", { exact: true })).toHaveCount(0);
});
