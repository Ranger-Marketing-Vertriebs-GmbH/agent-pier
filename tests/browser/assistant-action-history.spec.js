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

// AGENTPIER-443: an agent's coding session start is no memory change, and only a
// live session offers Stop.
test("coding session starts show their session's state and stop only a live session", async ({
  page,
}) => {
  const stopped = [];
  const start = (id, sessionEnded) => ({
    id,
    revision: 3,
    assistantId: "home",
    state: "running",
    projectName: "beta",
    sessionId: `${id}-session`,
    sessionEnded,
    payload: { action: "session_start", projectId: "beta", options: { tool: "codex" } },
  });
  await history(page, [
    start("ended", true),
    start("live", false),
    {
      id: "question",
      revision: 2,
      assistantId: "home",
      state: "completed",
      projectName: "beta",
      payload: { action: "session_request", sessionId: "live-session", title: "curl" },
    },
  ]);
  // After the fixture's own routes, which refuse every request they do not know.
  await page.route(/\/api\/sessions\/[^/]+\/stop$/, async (route) => {
    stopped.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: { id: "live-session", status: "stopped" } });
  });
  await expect(
    page.getByRole("heading", { name: "Coding session", exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("heading", { name: "Question from a coding session" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project memory change" })).toHaveCount(
    0,
  );
  await expect(page.getByText("Session running", { exact: true })).toBeVisible();
  await expect(page.getByText("Session ended", { exact: true })).toBeVisible();
  await expect(page.getByText("beta · Codex").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop coding task" })).toHaveCount(0);
  const stop = page.getByRole("button", { name: "Stop session", exact: true });
  await expect(stop).toHaveCount(1);
  await stop.click();
  await expect.poll(() => stopped).toEqual(["/api/sessions/live-session/stop"]);
});
