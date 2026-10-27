import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { recordApiRequests, setTabHidden } from "../helpers/visibility.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { explorerFixture, selectEnglish } from "../helpers/file-explorer-browser.js";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";
import { hubFixture } from "./projects-fixture.js";
import { fixture as providersFixture } from "./providers-fixture.js";

// A hidden tab sends nothing for six seconds; showing it again reads at once.
async function pausesWhenHidden(page, requests, resumed) {
  await setTabHidden(page, true);
  requests.clear();
  await page.waitForTimeout(6000);
  expect(requests.list()).toEqual([]);
  await setTabHidden(page, false);
  await expect
    .poll(() => requests.list().some((request) => resumed.test(request.path)), {
      timeout: 1000,
    })
    .toBe(true);
}

test("a hidden run detail sends no API request and resumes when visible", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  const requests = recordApiRequests(page);
  await openPipelines(page, "runs/run-one");
  await expect(page.getByText("Review the application").first()).toBeVisible();
  await pausesWhenHidden(page, requests, /\/api\//);
});

test("hidden run list pills pause and resume", async ({ page }) => {
  const state = await pipelinesFixture(page);
  state.runs.push(sampleRun(state));
  const requests = recordApiRequests(page);
  await openPipelines(page, "runs");
  await expect(page.getByText("Review the application").first()).toBeVisible();
  await pausesWhenHidden(page, requests, /\/api\/pipeline-runs/);
});

test("a hidden session chat pauses the model and reload reads", async ({ page }) => {
  const session = {
    id: "hidden-demo",
    name: "Hidden demo",
    tool: "codex",
    accountId: "local-codex",
    cwd: "/home/test/project",
    status: "running",
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let json = {};
    if (path === "/api/state")
      json = {
        tools: [{ id: "codex", name: "Codex", installed: true }],
        accounts: [{ id: "local-codex", name: "Codex", tool: "codex", kind: "local" }],
        sessions: [session],
        home: "/home/test",
      };
    else if (path.endsWith("/models"))
      json = { currentModel: "gpt-5.6-sol", currentSource: "cli", pending: false };
    else if (path.endsWith("/requests")) json = { requests: [] };
    else if (path.endsWith("/reload"))
      json = { eligible: true, reason: null, state: "idle", activity: { state: "busy" } };
    return route.fulfill({ json });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", () => {});
  await mockChatStream(page, () => ({
    availability: "ready",
    providerSessionId: "native-demo",
    messages: [{ id: "a1", role: "assistant", text: "Existing chat" }],
    tasks: [],
  }));
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const requests = recordApiRequests(page);
  await page.goto(baseURL + "/sessions/hidden-demo/chat");
  await expect(page.getByRole("button", { name: "Choose model" })).toContainText(
    "gpt-5.6-sol",
  );
  await page.getByRole("button", { name: "Reload & resume", exact: true }).click();
  await expect
    .poll(() => requests.list().some((request) => request.path.endsWith("/reload")))
    .toBe(true);
  await pausesWhenHidden(page, requests, /\/models$/);
  await expect
    .poll(() => requests.list().some((request) => request.path.endsWith("/reload")))
    .toBe(true);
});

test("hidden Projects pause the AgentBus, run count and message reads", async ({
  page,
}) => {
  await hubFixture(page, {
    intercept: (route, url) => {
      if (!/\/api\/agentbus\/projects\/[^/]+\/messages$/.test(url.pathname)) return false;
      return route
        .fulfill({
          json: { projectId: "b1", page: 1, pageSize: 20, total: 0, items: [] },
        })
        .then(() => true);
    },
  });
  const requests = recordApiRequests(page);
  await page.goto(baseURL + "/projects/m1?tab=agentbus");
  await expect(page.getByRole("radiogroup", { name: "AgentBus-Ansicht" })).toBeVisible();
  await pausesWhenHidden(page, requests, /\/api\/agentbus$/);
});

test("AgentBus status and messages are read at most twice in 12 s", async ({ page }) => {
  test.setTimeout(30000);
  await hubFixture(page, {
    intercept: (route, url) => {
      if (!/\/api\/agentbus\/projects\/[^/]+\/messages$/.test(url.pathname)) return false;
      return route
        .fulfill({
          json: { projectId: "b1", page: 1, pageSize: 20, total: 0, items: [] },
        })
        .then(() => true);
    },
  });
  const requests = recordApiRequests(page);
  await page.goto(baseURL + "/projects/m1?tab=agentbus");
  await expect(page.getByRole("radiogroup", { name: "AgentBus-Ansicht" })).toBeVisible();
  requests.clear();
  await page.getByRole("radio", { name: /^Nachrichten/ }).click({ force: true });
  await page.waitForTimeout(12000);
  const reads = (suffix) =>
    requests.list().filter((request) => request.path.endsWith(suffix)).length;
  expect(reads("/messages")).toBeLessThanOrEqual(2);
  expect(reads("/api/agentbus")).toBeLessThanOrEqual(2);
});

test("a hidden editor pauses its file metadata read and resumes on show", async ({
  page,
}) => {
  await explorerFixture(page);
  const path = "/home/test/readme.txt";
  await page.route("**/api/files/text**", (route) =>
    route.fulfill({
      json: {
        path,
        resolvedPath: path,
        text: "Hello\n",
        bom: false,
        lineEnding: "lf",
        readOnly: false,
        revision: `d1:${"1".repeat(64)}`,
        metadataRevision: `e1:${"1".repeat(64)}`,
      },
    }),
  );
  await selectEnglish(page);
  const requests = recordApiRequests(page);
  await page.goto(
    `${baseURL}/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`,
  );
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: `Document content: ${path}` }),
  ).toBeVisible();
  await pausesWhenHidden(page, requests, /\/api\/files\/metadata/);
});

test("hidden Accounts pause the CLI sign-in reads", async ({ page }) => {
  const controls = await providersFixture(page);
  controls.state.accounts = [
    { id: "managed-codex", name: "Work Codex", tool: "codex", kind: "managed" },
  ];
  await page.route("**/api/accounts/*/auth-status", (route) =>
    route.fulfill({ json: { state: "authenticated" } }),
  );
  const requests = recordApiRequests(page);
  await page.goto(baseURL + "/accounts?section=cli&item=managed-codex");
  await expect(page.locator(".accounts-detail")).toBeVisible();
  await pausesWhenHidden(page, requests, /\/auth-status$/);
});
