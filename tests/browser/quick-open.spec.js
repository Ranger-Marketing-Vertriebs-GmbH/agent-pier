// Quick open (AGENTPIER-224): the ⌘K / Ctrl+K palette finds sessions, projects, chats,
// runs, pipelines and inbox items besides pages and actions, fuzzy and recent first;
// arrows and Enter open a result. Ctrl+K stays with a focused terminal (readline's
// kill-line) on Linux, ⌘K opens the palette from it on macOS; phones open it from a
// button; a restricted user's palette holds only the user's own agents and pages.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { userAgent, userAppFixture } from "../helpers/user-app-fixture.js";

const dialog = (page) => page.getByRole("dialog", { name: "Search" });
const field = (page) => dialog(page).getByRole("combobox");
const options = (page) => dialog(page).getByRole("option");
const group = (page, name) => dialog(page).getByRole("group", { name });

// The platform the app sees (search-shortcut.js, xterm): macOS or Linux.
async function platform(page, name) {
  await page.addInitScript((mac) => {
    const value = mac ? "MacIntel" : "Linux x86_64";
    const data = { platform: mac ? "macOS" : "Linux", brands: [], mobile: false };
    Object.defineProperty(Navigator.prototype, "platform", {
      get: () => value,
      configurable: true,
    });
    Object.defineProperty(Navigator.prototype, "userAgentData", {
      get: () => data,
      configurable: true,
    });
  }, name === "mac");
}

const session = {
  id: "billing-refactor",
  name: "Refactor billing",
  tool: "claude",
  accountId: "work-claude",
  cwd: "/fixture/billing-api",
  status: "running",
};

// The owner's workspace in English, Linux: one session, project, run, pipeline, inbox
// item and agent chat, each from the route the owner's pages read it from.
async function ownerFixture(page, { os = "linux" } = {}) {
  await platform(page, os);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const json = (route, body) => route.fulfill({ json: body });
  await page.route(/\/api\//, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") return route.fallback();
    if (path === "/api/state")
      return json(route, {
        tools: [{ id: "claude", name: "Claude Code", installed: true }],
        accounts: [{ id: "work-claude", name: "Work account", tool: "claude" }],
        sessions: [session],
        home: "/fixture",
      });
    if (path === "/api/memory/projects")
      return json(route, {
        projects: [
          { id: "proj-billing", name: "billing-api", cwd: "/fixture/billing-api" },
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
            task: "Fix the flaky login test",
            status: "failed",
            pipelineName: "Code review",
            createdAt: "2026-10-30T09:00:00.000Z",
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
            title: "Run npm publish",
            source: { name: "Refactor billing" },
            createdAt: "2026-10-30T09:00:00.000Z",
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
            id: "scout",
            name: "Scout",
            model: { connectionId: "router", modelId: "m" },
            capabilities: { memory: true },
            revision: 1,
          },
        ],
        conversations: [
          { id: "c1", assistantId: "scout", main: true, title: null },
          { id: "c2", assistantId: "scout", title: "Travel planning" },
        ],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        teams: [],
        members: [],
        policies: {},
        teamSettings: { revision: 0, hostMaxConcurrent: 8 },
      });
    return route.fallback();
  });
  // The session's terminal: records what the page types into it.
  const typed = [];
  await page.routeWebSocket("**/api/sessions/*/terminal", (socket) => {
    socket.onMessage((message) => {
      try {
        const frame = JSON.parse(String(message));
        if (frame.type === "input") typed.push(frame.data);
      } catch {
        // Not a frame of ours.
      }
    });
    socket.send(JSON.stringify({ type: "output", data: "ready\r\n❯ " }));
  });
  return { typed };
}

// Touch screens leave the focus on the dialog (no on-screen keyboard at once).
async function openWithShortcut(page, keys = "Control+k", { touch = false } = {}) {
  await page.keyboard.press(keys);
  await expect(dialog(page)).toBeVisible();
  if (!touch) await expect(field(page)).toBeFocused();
}

test("finds sessions, runs, inbox items, projects and chats, fuzzy and recent first", async ({
  page,
}) => {
  await ownerFixture(page);
  await page.goto(baseURL + "/projects");
  await expect(page.locator(".sidebar")).toBeVisible();
  await openWithShortcut(page);
  await expect(group(page, "Actions")).toContainText("Start run");
  await expect(group(page, "Recent")).toHaveCount(0);

  // A session by its project and CLI; arrows move, Enter opens it.
  await field(page).fill("billing claude");
  const sessions = group(page, "Sessions");
  await expect(sessions.getByRole("option").first()).toContainText("Refactor billing");
  await expect(sessions.getByRole("option").first()).toContainText(
    "Sessions › billing-api · Claude Code · Work account",
  );
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/sessions\/billing-refactor/);

  // The session is the first recent result now.
  await page.locator(".sidebar .sidebar-menu-button").focus();
  await openWithShortcut(page);
  await expect(group(page, "Recent").getByRole("option").first()).toContainText(
    "Refactor billing",
  );
  await page.keyboard.press("Escape");

  // A run despite the typo, under Pipelines with its status.
  await openWithShortcut(page);
  await field(page).fill("flaky logn");
  const run = group(page, "Pipelines").getByRole("option").first();
  await expect(run).toContainText("Fix the flaky login test");
  await expect(run).toContainText("Pipelines › Runs › Code review · Failed");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/pipelines\/runs\/run-42$/);

  // An inbox item, then a project, a chat, a pipeline and an action.
  for (const [query, groupName, address] of [
    ["npm publish", "Inbox", /\/inbox\/approval\/appr-1$/],
    ["billing-api", "Projects", /\/projects\/proj-billing$/],
    ["scout travel", "Chats", /\/agents\/scout\/chats\/c2$/],
    ["code review", "Pipelines", /\/pipelines\/definitions\/review$/],
    ["start run", "Actions", /\/pipelines\/runs\/new$/],
  ]) {
    await page.locator(".sidebar .sidebar-menu-button").focus();
    await openWithShortcut(page);
    await field(page).fill(query);
    await expect(group(page, groupName).getByRole("option").first()).toBeVisible();
    await group(page, groupName).getByRole("option").first().click();
    await expect(page).toHaveURL(address);
  }
});

test("settings are found by their English labels and old names stay findable", async ({
  page,
}) => {
  await ownerFixture(page);
  await page.goto(baseURL + "/projects");
  await expect(page.locator(".sidebar")).toBeVisible();
  await openWithShortcut(page);
  await field(page).fill("remote acess");
  await expect(group(page, "Pages").getByRole("option").first()).toContainText(
    "Remote access",
  );
  await field(page).fill("zzqqxx");
  await expect(dialog(page)).toContainText("Nothing found for “zzqqxx”");
  await dialog(page).getByRole("button", { name: "Clear search" }).click();
  await expect(field(page)).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("on Linux Ctrl+K in the terminal stays the terminal's kill-line", async ({
  page,
}) => {
  const { typed } = await ownerFixture(page);
  await page.goto(baseURL + "/sessions/billing-refactor/terminal");
  await expect(page.locator(".xterm-rows")).toContainText("ready");
  // The palette has loaded once, so a missing dialog is not a slow one.
  await page.locator(".sidebar .sidebar-menu-button").focus();
  await openWithShortcut(page);
  await page.keyboard.press("Escape");
  await page.locator(".xterm").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.press("Control+k");
  await expect.poll(() => typed.join("")).toContain("\u000b");
  await expect(dialog(page)).toHaveCount(0);
  // Outside the terminal the same keys open it.
  await page.locator(".sidebar .sidebar-menu-button").focus();
  await openWithShortcut(page);
});

test("on macOS ⌘K opens the palette from the terminal and types nothing", async ({
  page,
}) => {
  const { typed } = await ownerFixture(page, { os: "mac" });
  await page.goto(baseURL + "/sessions/billing-refactor/terminal");
  await expect(page.locator(".xterm-rows")).toContainText("ready");
  await page.locator(".xterm").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("ls");
  await expect.poll(() => typed.join("")).toBe("ls");
  await openWithShortcut(page, "Meta+k");
  expect(typed.join("")).toBe("ls");
  // Escape returns to the terminal, which keeps working.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  // Ctrl+K on macOS stays the terminal's.
  await page.keyboard.press("Control+k");
  await expect.poll(() => typed.join("")).toBe("ls\u000b");
  await expect(dialog(page)).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the header and the drawer have a search button", async ({ page }) => {
    await ownerFixture(page);
    await page.goto(baseURL + "/");
    const header = page.locator(".mobile-header");
    await header.getByRole("button", { name: "Search", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await field(page).fill("refactor");
    await expect(options(page).first()).toContainText("Refactor billing");
    const sheet = await dialog(page).boundingBox();
    expect(sheet.width).toBe(390);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    // In the drawer the search button sits beside the menu, a full tap target.
    await header.getByRole("button", { name: "Open navigation" }).click();
    const button = page
      .locator(".sidebar-head")
      .getByRole("button", { name: "Search (Ctrl+K)" });
    const box = await button.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await button.click();
    await expect(dialog(page)).toBeVisible();
    await options(page).filter({ hasText: "Start run" }).click();
    await expect(page).toHaveURL(/\/pipelines\/runs\/new$/);
    await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  });

  test("a user's palette holds only the user's agents and pages", async ({ page }) => {
    await platform(page, "linux");
    const state = await userAppFixture(page, {
      agents: [
        userAgent(),
        userAgent({ id: "helper", name: "Helper", shared: true, conversationId: "h1" }),
      ],
    });
    await page.goto(baseURL + "/agents");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(field(page)).toHaveAttribute(
      "aria-label",
      "Search your agents, chats or account",
    );
    await expect(group(page, "Pages").getByRole("option")).toHaveText([
      /My agents/,
      /Account/,
    ]);
    for (const owner of ["Sessions", "Pipelines", "Remote access", "SSH", "Inbox"]) {
      await field(page).fill(owner);
      await expect(options(page)).toHaveCount(0);
    }
    await field(page).fill("lotta");
    await expect(options(page).first()).toContainText("Chat with Lotta");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/agents\/lotta\/chats\/main$/);
    // Ctrl+K opens it too; the user's recent result comes first.
    await page.locator(".user-search-button").focus();
    await openWithShortcut(page, "Control+k", { touch: true });
    await expect(group(page, "Recent").getByRole("option").first()).toContainText(
      "Chat with Lotta",
    );
    await field(page).fill("helper memory");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/agents\/helper\/settings\?page=memory$/);
    expect(state.foreign).toEqual([]);
  });
});
