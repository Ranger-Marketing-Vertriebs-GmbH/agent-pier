import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { recordApiRequests, setTabHidden } from "../helpers/visibility.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { explorerFixture, selectEnglish } from "../helpers/file-explorer-browser.js";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";
import { hubFixture } from "./projects-fixture.js";
import { fixture as providersFixture } from "./providers-fixture.js";
import { fixture as reaFixture, reaState, card as reaCard } from "./rea-fixture.js";

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

// A codex chat; `stall` lets a test hold the model or reload read after the first.
async function sessionFixture(page, stall = {}) {
  const session = {
    id: "hidden-demo",
    name: "Hidden demo",
    tool: "codex",
    accountId: "local-codex",
    cwd: "/home/test/project",
    status: "running",
  };
  const seen = { models: 0, reload: 0 };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json = {};
    if (path === "/api/state")
      json = {
        tools: [{ id: "codex", name: "Codex", installed: true }],
        accounts: [{ id: "local-codex", name: "Codex", tool: "codex", kind: "local" }],
        sessions: [session],
        home: "/home/test",
      };
    else if (path.endsWith("/models")) {
      if (stall.models && ++seen.models > 1)
        await new Promise((r) => setTimeout(r, 17000));
      json = { currentModel: "gpt-5.6-sol", currentSource: "cli", pending: false };
    } else if (path.endsWith("/requests")) json = { requests: [] };
    else if (path.endsWith("/reload")) {
      if (stall.reload && ++seen.reload > 1)
        await new Promise((r) => setTimeout(r, 17000));
      json = { eligible: true, reason: null, state: "idle", activity: { state: "busy" } };
    }
    return route.fulfill({ json }).catch(() => {});
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", () => {});
  await mockChatStream(page, () => ({
    availability: "ready",
    providerSessionId: "native-demo",
    messages: [{ id: "a1", role: "assistant", text: "Existing chat" }],
    tasks: [],
  }));
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
}

test("a hidden session chat pauses the model and reload reads", async ({ page }) => {
  await sessionFixture(page);
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

test("a stalled model read reports its timeout while hidden stays silent", async ({
  page,
}) => {
  test.setTimeout(60000);
  await sessionFixture(page, { models: true });
  await page.goto(baseURL + "/sessions/hidden-demo/chat");
  await expect(page.getByRole("button", { name: "Choose model" })).toContainText(
    "gpt-5.6-sol",
  );
  await expect(page.getByText(/The model status request timed out/)).toBeVisible({
    timeout: 25000,
  });
  // The chat stays usable.
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled();
});

test("a stalled reload read shows a timeout in the dialog", async ({ page }) => {
  test.setTimeout(60000);
  await sessionFixture(page, { reload: true });
  await page.goto(baseURL + "/sessions/hidden-demo/chat");
  await page.getByRole("button", { name: "Reload & resume", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "The server did not answer in time.",
    { timeout: 25000 },
  );
});

test("login status is not requested while hidden and is read once on show", async ({
  page,
}) => {
  const statuses = [];
  await page.addInitScript(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
  });
  await page.route("**/auth/status", (route) => {
    statuses.push(route.request().url());
    return route.fulfill({
      json: { configured: true, authenticated: true, canSetup: false },
    });
  });
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.goto(baseURL + "/settings");
  await page.waitForTimeout(2000);
  expect(statuses).toEqual([]);
  await setTabHidden(page, false);
  await expect.poll(() => statuses.length, { timeout: 1000 }).toBe(1);
});

// A codex install dialog over a stubbed installer; `job` is the codex installation.
async function installerFixture(page, job, stall = false) {
  const reads = { count: 0 };
  const installation = {
    tool: "codex",
    name: "Codex",
    packageName: "@openai/codex",
    status: "idle",
    available: true,
    destination: "/home/server/.local/share/agentpier/clis/codex",
    ...job,
  };
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "codex", name: "Codex", installed: false }],
          accounts: [],
          sessions: [],
          home: "/home/server",
        },
      });
    if (path === "/api/tool-installations") {
      if (stall && ++reads.count > 1) await new Promise((r) => setTimeout(r, 17000));
      return route.fulfill({
        json: {
          installations: [installation],
          busy: installation.status === "running",
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(baseURL + "/coding/clis");
  await page.getByRole("button", { name: "Install CLI", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("an idle tool installation is not polled", async ({ page }) => {
  const requests = recordApiRequests(page);
  await installerFixture(page, {});
  await expect
    .poll(() => requests.list().some((r) => r.path === "/api/tool-installations"))
    .toBe(true);
  await page.waitForTimeout(500);
  requests.clear();
  await page.waitForTimeout(6000);
  expect(requests.list().filter((r) => r.path === "/api/tool-installations")).toEqual([]);
});

test("a running tool installation pauses while hidden and reads on show", async ({
  page,
}) => {
  const requests = recordApiRequests(page);
  await installerFixture(page, { status: "running", message: "Installing" });
  await pausesWhenHidden(page, requests, /\/api\/tool-installations/);
});

test("a stalled tool installation read shows a timeout", async ({ page }) => {
  test.setTimeout(60000);
  await installerFixture(page, { status: "running", message: "Installing" }, true);
  await expect(page.getByRole("dialog")).toContainText(
    "The server did not answer in time.",
    { timeout: 25000 },
  );
});

test("a hidden REA dialog sends no REA read while a job runs", async ({ page }) => {
  const requests = recordApiRequests(page);
  await reaFixture(page, reaState({ status: "running", step: "core", message: "…" }));
  await reaCard(page).getByRole("button", { name: "Install" }).click();
  await expect(page.getByRole("dialog", { name: "REA" })).toBeVisible();
  await pausesWhenHidden(page, requests, /\/api\/rea/);
});
