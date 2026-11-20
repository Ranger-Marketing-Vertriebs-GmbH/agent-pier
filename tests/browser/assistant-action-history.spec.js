import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { fixture } from "./providers-fixture.js";

// The agent's "Actions and coding tasks" page over a fixed list of actions.
async function history(page, actions, { cancel } = {}) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const url = new URL(route.request().url()),
      method = route.request().method();
    let body;
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
        policies: {},
        models: [{ id: "router", name: "Router", available: true }],
      };
    else if (url.pathname === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (url.pathname === "/api/assistant-workspace-catalog")
      body = { projects: [], pipelines: [], sshHosts: [], secrets: [] };
    else if (url.pathname.endsWith("/shell-allowlist")) body = { entries: [] };
    else if (url.pathname.endsWith("/attachment-usage"))
      body = { files: 0, bytes: 0, maxFiles: 1000, maxBytes: 1073741824 };
    else if (url.pathname === "/api/assistant-channels") body = { channels: [] };
    else if (url.pathname.endsWith("/actions")) body = { actions };
    else if (url.pathname.endsWith("/cancel") && method === "POST") {
      cancel?.(url.pathname);
      body = {};
    } else return route.fallback();
    await route.fulfill({ json: body });
  });
  await page.goto(baseURL + settingsPath("overview", "actions"));
}

test("a shell command whose approval the agent stopped waiting for says it did not run", async ({
  page,
}) => {
  await history(page, [
    {
      id: "exec",
      revision: 2,
      assistantId: "home",
      state: "failed",
      result: { reason: "request-failed" },
      payload: { action: "exec", approvalId: "a-1", command: "echo w4b-shell-ok" },
    },
  ]);
  await expect(page.getByText("echo w4b-shell-ok", { exact: true })).toBeVisible();
  await expect(page.getByText("Failed", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/The command did not run: the agent stopped waiting/),
  ).toBeVisible();
  await expect(page.getByText(/^Der Befehl/)).toHaveCount(0);
});
