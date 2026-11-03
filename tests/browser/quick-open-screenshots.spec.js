// The quick open screenshots of the UI guide: the ⌘K palette with results from several
// groups on a desktop, and the same palette as a bottom sheet on a phone. Normal runs
// only check the scene; AGENTPIER_UPDATE_DOC_SCREENSHOTS=1 refreshes the images under
// docs/screenshots.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { docScreenshot } from "../helpers/doc-screenshots.js";

const dialog = (page) => page.getByRole("dialog", { name: "Search" });
const field = (page) => dialog(page).getByRole("combobox");
const group = (page, name) => dialog(page).getByRole("group", { name });

const at = "2026-11-01T09:00:00.000Z";
const sessions = [
  {
    id: "billing",
    name: "Refactor billing",
    tool: "claude",
    accountId: "work-claude",
    cwd: "/fixture/billing-api",
    status: "running",
    activity: { state: "idle" },
  },
  {
    id: "shop",
    name: "Shop UI",
    tool: "codex",
    accountId: "local-codex",
    cwd: "/fixture/shop",
    status: "running",
    activity: { state: "working" },
  },
];

// An English owner workspace on macOS with sessions, projects, runs, pipelines, an
// inbox item and agent chats; other reads go to the test server.
async function workspaceFixture(page) {
  await page.addInitScript(() => {
    localStorage.setItem("agentpier-language", "en");
    // Recently opened results, newest first (recent-items.js).
    localStorage.setItem(
      "agentpier-search-recent:owner",
      JSON.stringify(["session:billing", "chat:c2", "run:run-42"]),
    );
    // macOS on every runner, so ⌘K opens the palette (search-shortcut.js).
    const data = { platform: "macOS", brands: [], mobile: false };
    Object.defineProperty(Navigator.prototype, "platform", {
      get: () => "MacIntel",
      configurable: true,
    });
    Object.defineProperty(Navigator.prototype, "userAgentData", {
      get: () => data,
      configurable: true,
    });
  });
  const json = (route, body) => route.fulfill({ json: body });
  await page.route(/\/api\//, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") return route.fallback();
    if (path === "/api/state")
      return json(route, {
        tools: [
          { id: "claude", name: "Claude Code", installed: true },
          { id: "codex", name: "Codex", installed: true },
        ],
        accounts: [
          { id: "work-claude", name: "Work account", tool: "claude" },
          { id: "local-codex", name: "Codex", tool: "codex", kind: "local" },
        ],
        sessions,
        home: "/fixture",
      });
    if (path === "/api/memory/projects")
      return json(route, {
        projects: [
          { id: "proj-billing", name: "billing-api", cwd: "/fixture/billing-api" },
          { id: "proj-shop", name: "shop", cwd: "/fixture/shop" },
        ],
      });
    if (path === "/api/pipelines")
      return json(route, {
        pipelines: [
          { id: "review", name: "Code review", graph: { nodes: [], edges: [] } },
        ],
      });
    if (path === "/api/pipeline-runs")
      return json(route, {
        runs: [
          {
            id: "run-42",
            task: "Round invoice totals in billing",
            status: "failed",
            pipelineName: "Code review",
            createdAt: at,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    if (path === "/api/inbox")
      return json(route, {
        instance: "fixture",
        revision: 1,
        items: [
          {
            type: "approval",
            id: "appr-1",
            tab: "approvals",
            kind: "shell",
            title: "Run npm test -- billing",
            source: { name: "Refactor billing" },
            createdAt: at,
          },
        ],
        counts: { all: 1, approvals: 1 },
      });
    if (path === "/api/assistant-feature")
      return json(route, { enabled: true, error: null });
    if (path === "/api/assistant-runtime")
      return json(route, { availability: "ready", sync: "current" });
    if (path === "/api/assistants")
      return json(route, {
        assistants: [
          {
            id: "planner",
            name: "Planner",
            model: { connectionId: "router", modelId: "anthropic/claude-sonnet-5" },
            capabilities: { memory: true },
            revision: 1,
          },
        ],
        conversations: [
          { id: "c1", assistantId: "planner", main: true, title: null },
          { id: "c2", assistantId: "planner", title: "Billing release checklist" },
        ],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        teams: [],
        members: [],
        policies: {},
        teamSettings: { revision: 0, hostMaxConcurrent: 8 },
      });
    return route.fallback();
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (socket) =>
    socket.send(JSON.stringify({ type: "output", data: "❯ " })),
  );
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("⌘K finds sessions, projects, runs, inbox items and chats in one list", async ({
    page,
  }) => {
    await workspaceFixture(page);
    await page.goto(baseURL + "/projects");
    await expect(page.locator(".sidebar")).toContainText("Refactor billing");
    await page.keyboard.press("Meta+k");
    await expect(field(page)).toBeFocused();
    await field(page).fill("billing");
    for (const name of ["Sessions", "Projects", "Pipelines", "Inbox", "Chats"])
      await expect(group(page, name)).toBeVisible();
    await page.screenshot({ path: docScreenshot("docs/screenshots/search-desktop.png") });
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the header's search button opens the palette as a bottom sheet", async ({
    page,
  }) => {
    await workspaceFixture(page);
    await page.goto(baseURL + "/");
    await page
      .locator(".mobile-header")
      .getByRole("button", { name: "Search", exact: true })
      .click();
    await expect(group(page, "Recent")).toContainText("Refactor billing");
    await page.screenshot({ path: docScreenshot("docs/screenshots/search-phone.png") });
  });
});
