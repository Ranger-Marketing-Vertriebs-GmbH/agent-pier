import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { fixture } from "./providers-fixture.js";

// The Work tab sets direct folder access per allowed project (AGENTPIER-123).
test("English Work tab grants a project folder for reading and writing and removes it with the project", async ({
  page,
}) => {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  let policy = {
    revision: 0,
    projectIds: [],
    projectFiles: {},
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
  await page.goto(baseURL + settingsPath("work"));
  await page.getByRole("link", { name: /^Allowed projects/ }).click();
  await expect(page.getByText("/Users/me/demo", { exact: true })).toHaveCount(1);
  // Folder access appears only for an allowed project, and starts at none.
  await expect(page.getByText("Direct folder access", { exact: true })).toHaveCount(0);
  await page.getByLabel("Demo project", { exact: true }).check();
  await expect(page.getByLabel("None", { exact: true })).toBeChecked();
  await page.getByLabel("Read and write", { exact: true }).check();
  await expect(
    page.getByText(/changes files directly, without an approval/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to Work" }).click();
  await expect(page.getByText("1 with folder access", { exact: true })).toBeVisible();
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].projectIds).toEqual(["project"]);
  expect(saves[0].projectFiles).toEqual({ project: "write" });
  // Removing the project removes its folder access as well.
  await page.getByRole("link", { name: /^Allowed projects/ }).click();
  await expect(page.getByLabel("Read and write", { exact: true })).toBeChecked();
  await page.getByLabel("Demo project", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Back to Work" }).click();
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toMatchObject({ projectIds: [], projectFiles: {} });
});
