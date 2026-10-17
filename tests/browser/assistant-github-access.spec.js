import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { fixture } from "./providers-fixture.js";

// The Work tab gives an agent GitHub through a token profile (AGENTPIER-129).
test("English Work tab grants GitHub with the default profile, warns on missing scopes and removes it", async ({
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
    github: null,
  };
  const saves = [];
  let installs = 0;
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
            shell: "full",
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
        projects: [],
        pipelines: [],
        sshHosts: [],
        github: {
          profiles: [
            {
              id: "personal",
              name: "Personal",
              host: "https://github.com",
              agentDefault: false,
              scopes: ["gist"],
            },
            {
              id: "work",
              name: "Company",
              host: "https://github.com",
              agentDefault: true,
              scopes: null,
            },
          ],
          server: { available: true, installed: false, status: "failed", message: "" },
        },
      };
    else if (url.pathname === "/api/assistant-github-server/install") {
      installs++;
      body = { available: true, installed: false, status: "running", message: "" };
    } else if (url.pathname.endsWith("/work") && method === "PUT") {
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
  await expect(page.getByRole("link", { name: /^GitHub\s*No access/ })).toBeVisible();
  await page.getByRole("link", { name: /^GitHub/ }).click();
  await expect(
    page.getByText(/The token never appears in its instructions or files/),
  ).toBeVisible();
  await expect(page.getByLabel("No access", { exact: true })).toBeChecked();
  // Choosing a level prefills the host's default profile for agents.
  await page.getByLabel("Read", { exact: true }).check();
  await expect(page.getByRole("radio", { name: "Company", exact: true })).toBeChecked();
  await expect(
    page.getByText(/gh and git in this agent's commands use this profile/),
  ).toBeVisible();
  // A token whose scopes are known and lack repo shows the hint.
  await page.getByLabel("Personal", { exact: true }).check();
  await expect(page.getByText("This token lacks the scope needed: repo.")).toBeVisible();
  await page.getByRole("radio", { name: "Company", exact: true }).check();
  await expect(page.locator("[data-github-scopes]")).toHaveCount(0);
  await page.getByLabel("Read and write", { exact: true }).check();
  await expect(
    page.getByText(/merge pull requests, push changes and delete files/),
  ).toBeVisible();
  await expect(page.getByText(/about 45 MB of memory each/)).toBeVisible();
  // A failed install of the MCP server can be retried here.
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("The GitHub MCP server is being installed …"),
  ).toBeVisible();
  expect(installs).toBe(1);
  await page.getByRole("button", { name: "Back to Work" }).click();
  await expect(
    page.getByRole("link", { name: /^GitHub\s*Read and write · Company/ }),
  ).toBeVisible();
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].github).toEqual({ credentialId: "work", level: "write" });
  // Saving something else sends no GitHub access; "No access" removes it.
  await page.getByLabel("Allow selected pipelines to publish pull requests").check();
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect("github" in saves[1]).toBe(false);
  await page.getByRole("link", { name: /^GitHub/ }).click();
  await page.getByLabel("No access", { exact: true }).check();
  await page.getByRole("button", { name: "Back to Work" }).click();
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saves.length).toBe(3);
  expect(saves[2].github).toBe(null);
});
