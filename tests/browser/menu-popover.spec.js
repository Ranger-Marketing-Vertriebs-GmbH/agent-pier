// The Menü popover, variant A (handoff §5.1, AC-NAV-1…6): groups Arbeiten and
// Einrichten, the active area, hints from their sources, agents off, the group head
// icons of the sidebar and the phone drawer.
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { openMenu } from "../helpers/navigation.js";

const trigger = (page) => page.locator(".sidebar .sidebar-menu-button");
const popover = (page) => page.locator("#sidebar-menu");
const entry = (page, name) => popover(page).getByRole("button", { name, exact: true });
const group = (page, name) => popover(page).getByRole("group", { name, exact: true });

// Hint sources answered by the test; `fail` lists sources that answer 500.
async function hintSources(page, { fail = [], agents = false } = {}) {
  const failing = (key) => fail.includes(key);
  await page.route("**/api/pipeline-runs?*", (route) => {
    const status = new URL(route.request().url()).searchParams.get("status");
    if (failing("runs")) return route.fulfill({ status: 500, json: { error: "down" } });
    const total = { "awaiting-human": 2, running: 1, failed: 4 }[status] ?? 0;
    return route.fulfill({ json: { runs: [], total, page: 1, pageSize: 20 } });
  });
  await page.route("**/api/connections/problems", (route) =>
    failing("problems")
      ? route.fulfill({ status: 500, json: { error: "down" } })
      : route.fulfill({
          json: {
            agentsEnabled: agents,
            models: null,
            services: null,
            mcp: { total: 3, problems: [{ id: "m-1" }], warnings: [{ id: "m-2" }] },
            ssh: { total: 5, problems: [{ id: "s-1" }], warnings: [] },
            secrets: { total: 0, problems: [], warnings: [] },
            github: null,
          },
        }),
  );
  await page.route("**/api/settings/summary", (route) =>
    failing("summary")
      ? route.fulfill({ status: 500, json: { error: "down" } })
      : route.fulfill({
          json: {
            access: {},
            operations: {
              updates: { current: "2.7.0", checked: true, available: "2.8.0" },
            },
          },
        }),
  );
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    if (failing("state")) return route.fulfill({ status: 500, json: { error: "down" } });
    const json = await response.json();
    json.tools = [
      ...json.tools.filter((tool) => tool.id !== "codex"),
      {
        id: "codex",
        name: "Codex",
        installed: true,
        version: "0.1.0",
        minimumVersion: "9.0.0",
        versionStatus: "update-required",
      },
    ];
    await route.fulfill({ response, json });
  });
}

// Agents switched on with one agent and a ready runtime (and an OpenClaw update).
async function agentsOn(page, { runtime = "ready", update = true } = {}) {
  await page.route(/\/api\/assistant/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/assistant-feature")
      return route.fulfill({ json: { enabled: true, error: null } });
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: runtime, sync: "current" } });
    if (path === "/api/assistant-runtime/updates")
      return route.fulfill({
        json: {
          phase: "idle",
          blockers: [],
          currentVersion: "1.0.0",
          targetVersion: "1.1.0",
          affectedAssistants: 1,
          busy: false,
          candidateReady: false,
          recoveryRequired: false,
          updateAvailable: update,
        },
      });
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [
            {
              id: "scout",
              name: "Scout",
              model: { connectionId: "router", modelId: "m" },
              revision: 1,
            },
          ],
          conversations: [],
          models: [{ id: "router", name: "OpenRouter", available: true }],
          teams: [],
          members: [],
          policies: {},
          teamSettings: { revision: 0, hostMaxConcurrent: 8 },
        },
      });
    return route.fallback();
  });
}

test("the menu lists Arbeiten and Einrichten, marks the area and closes like before", async ({
  page,
}) => {
  await page.goto(baseURL + "/projects");
  await trigger(page).click();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect(entry(page, "Übersicht")).toBeFocused();
  const work = group(page, "Arbeiten");
  const setup = group(page, "Einrichten");
  await expect(work.getByRole("button")).toHaveText([
    "Übersicht",
    /^Projekte/,
    /^Pipelines/,
    "Dateien",
    "Artifacts",
  ]);
  await expect(setup.getByRole("button")).toHaveText([
    /^Agenten/,
    /^CLIs & Erweiterungen/,
    /^Zugänge/,
    /^Einstellungen/,
  ]);
  // Accounts and Erweiterungen are replaced; the inbox stays in the sidebar.
  for (const gone of ["Accounts", "Erweiterungen", "Eingang"])
    await expect(entry(page, gone)).toHaveCount(0);
  await expect(entry(page, "Projekte")).toHaveAttribute("aria-current", "page");
  await expect(entry(page, "Übersicht")).not.toHaveAttribute("aria-current");
  await expect(popover(page).locator(".host-status")).toBeVisible();
  await expect(popover(page).getByRole("button", { name: "Abmelden" })).toBeVisible();
  // Escape closes and returns focus to the button.
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  // An outside click closes.
  await trigger(page).click();
  await page.locator(".sidebar ~ main").click({ position: { x: 600, y: 400 } });
  await expect(popover(page)).toBeHidden();
  // Choosing an entry navigates, closes and returns focus.
  await trigger(page).click();
  await entry(page, "CLIs & Erweiterungen").click();
  await expect(page).toHaveURL(/\/coding\/clis$/);
  await expect(popover(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  await trigger(page).click();
  await expect(entry(page, "CLIs & Erweiterungen")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await entry(page, "Zugänge").click();
  await expect(page).toHaveURL(/\/connections$/);
  // An old address marks its new place.
  await page.goto(baseURL + "/settings/ssh");
  await openMenu(page);
  await expect(entry(page, "Zugänge")).toHaveAttribute("aria-current", "page");
  // Navigation from elsewhere (history) closes the menu too.
  await page.goBack();
  await expect(popover(page)).toBeHidden();
});

test("hints show what their sources report", async ({ page }) => {
  await hintSources(page);
  await page.goto(baseURL);
  await openMenu(page);
  const hint = (name) => entry(page, name).locator(".sidebar-menu-hint");
  await expect(hint("Projekte")).toHaveText("2 Entscheidungen");
  await expect(hint("Pipelines")).toHaveText("1 läuft");
  await expect(hint("CLIs & Erweiterungen")).toHaveText("1 Update");
  await expect(hint("Zugänge")).toHaveText("3 Probleme");
  await expect(hint("Einstellungen")).toHaveText("Update verfügbar");
  // Agents are off in the test server: the entry stays and says so.
  await expect(hint("Agenten")).toHaveText("aus");
  // The hint is the entry's description; its name stays the area.
  await expect(entry(page, "Projekte")).toHaveAccessibleDescription("2 Entscheidungen");
  await expect(hint("Übersicht")).toHaveCount(0);
});

test("a failing source shows no hint, never a zero", async ({ page }) => {
  await hintSources(page, { fail: ["runs", "problems", "summary"] });
  await page.goto(baseURL);
  await openMenu(page);
  for (const name of ["Projekte", "Pipelines", "Zugänge", "Einstellungen"])
    await expect(entry(page, name).locator(".sidebar-menu-hint"), name).toHaveCount(0);
  // The state that works still reports its outdated CLI.
  await expect(
    entry(page, "CLIs & Erweiterungen").locator(".sidebar-menu-hint"),
  ).toHaveText("1 Update");
});

test("with agents off, Agenten leads to the page that turns them on", async ({
  page,
}) => {
  await page.goto(baseURL);
  // The Agenten group of the sidebar stays hidden while agents are off.
  await expect(page.locator(".assistant-chats-group")).toHaveCount(0);
  await openMenu(page);
  await expect(entry(page, "Agenten")).toBeVisible();
  await entry(page, "Agenten").click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Agenten/);
});

test("with agents on, the hint names a ready update or a stopped service", async ({
  page,
}) => {
  await hintSources(page, { agents: true });
  await agentsOn(page);
  await page.goto(baseURL);
  await expect(page.locator(".assistant-chats-group")).toBeVisible();
  await openMenu(page);
  await expect(entry(page, "Agenten").locator(".sidebar-menu-hint")).toHaveText(
    "Update bereit",
  );
  await page.keyboard.press("Escape");
  await page.unrouteAll({ behavior: "wait" });
  await hintSources(page, { agents: true });
  await agentsOn(page, { runtime: "disabled", update: false });
  await page.reload();
  await openMenu(page);
  await expect(entry(page, "Agenten").locator(".sidebar-menu-hint")).toHaveText(
    "Dienst gestoppt",
  );
});

test("the sidebar head and the group heads offer their icon buttons", async ({
  page,
}) => {
  await agentsOn(page);
  await page.goto(baseURL);
  const head = page.locator(".sidebar-head");
  await expect(page.locator(".assistant-chats-group")).toBeVisible();
  // On screen: collapse, search and Menü in the first row, then the brand.
  const names = await head
    .locator(":scope > button, :scope > nav > button")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => ({ node, box: node.getBoundingClientRect() }))
        .sort((a, b) => Math.round(a.box.top - b.box.top) || a.box.left - b.box.left)
        .map(({ node }) => node.getAttribute("aria-label") || node.textContent.trim()),
    );
  expect(names).toEqual([
    "Navigation einklappen",
    "Suchen (⌘K)",
    "Menü",
    "AgentPier Startseite",
  ]);
  // The search button asks the app to open the search (the dialog comes later).
  await page.evaluate(() => {
    window.searchRequests = 0;
    window.addEventListener("agentpier:open-search", () => window.searchRequests++);
  });
  await head.getByRole("button", { name: "Suchen (⌘K)" }).click();
  expect(await page.evaluate(() => window.searchRequests)).toBe(1);
  const agents = page.locator(".assistant-chats-group .sidebar-group-actions");
  await expect(
    agents.getByRole("link", { name: "Alle Agenten verwalten" }),
  ).toHaveAttribute("href", "/agents");
  await expect(agents.getByRole("link", { name: "Neuer Agent" })).toHaveAttribute(
    "href",
    "/agents?new=1",
  );
  const sessions = page.locator(".sessions-group .sidebar-group-actions");
  await expect(
    sessions.getByRole("link", { name: "CLIs und Erweiterungen" }),
  ).toHaveAttribute("href", "/coding/clis");
  await agents.getByRole("link", { name: "Alle Agenten verwalten" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await agents.getByRole("link", { name: "Neuer Agent" }).click();
  await expect(page).toHaveURL(/\/agents\?new=1$/);
  await sessions.getByRole("link", { name: "CLIs und Erweiterungen" }).click();
  await expect(page).toHaveURL(/\/coding\/clis$/);
  await sessions.getByRole("button", { name: "Neue Session" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test.describe("English", () => {
  test.use({ locale: "en-GB" });
  test("groups, hints and head buttons follow the language", async ({ page }) => {
    await hintSources(page);
    await page.goto(baseURL);
    await expect(
      page.locator(".sidebar-head").getByRole("button", { name: "Search (⌘K)" }),
    ).toBeVisible();
    await expect(
      page.locator(".sessions-group").getByRole("link", { name: "CLIs and extensions" }),
    ).toBeVisible();
    await expect(
      page.locator(".sessions-group").getByRole("button", { name: "New session" }),
    ).toBeVisible();
    await openMenu(page);
    await expect(group(page, "Work").getByRole("button")).toHaveCount(5);
    await expect(group(page, "Set up").getByRole("button")).toHaveText([
      /^Agents/,
      /^CLIs & Erweiterungen|^CLIs and extensions/,
      /^Connections/,
      /^Settings/,
    ]);
    const hint = (name) => entry(page, name).locator(".sidebar-menu-hint");
    await expect(hint("Projects")).toHaveText("2 decisions");
    await expect(hint("Pipelines")).toHaveText("1 running");
    await expect(hint("Connections")).toHaveText("3 problems");
    await expect(hint("Agents")).toHaveText("off");
    await expect(hint("Settings")).toHaveText("Update available");
  });
});

test.describe("phone drawer", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("keeps today's drawer and opens the menu inside it with search first", async ({
    page,
  }) => {
    await agentsOn(page);
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
    const drawer = page.locator(".sidebar");
    await expect(drawer).toHaveClass(/open/);
    // Brand + Menü, Neu, Agenten, Sessions; no search or head icons in the drawer.
    await expect(drawer.locator(".brand")).toBeVisible();
    await expect(drawer.locator(".assistant-chats-group")).toBeVisible();
    await expect(trigger(page)).toBeVisible();
    await expect(drawer.locator(".sidebar-head .sidebar-search")).toBeHidden();
    await expect(drawer.locator(".sidebar-collapse")).toBeHidden();
    await expect(drawer.locator(".sidebar-group-actions").first()).toBeHidden();
    const order = await drawer
      .locator(".brand, .sidebar-launch, .assistant-chats-group, .sessions-group")
      .evaluateAll((nodes) =>
        nodes
          .map((node) => ({
            name: node.className,
            top: node.getBoundingClientRect().top,
          }))
          .sort((a, b) => a.top - b.top)
          .map((item) => item.name.split(" ")[0]),
      );
    expect(order).toEqual(["brand", "sidebar-launch", "sidebar-group", "sidebar-group"]);
    await trigger(page).click();
    const menu = popover(page);
    await expect(menu).toBeVisible();
    // Search is the first row and asks the app to open the search.
    const first = menu.locator("button").first();
    await expect(first).toHaveText("Suchen");
    await expect(first).toBeFocused();
    await expect(entry(page, "Eingang")).toHaveCount(0);
    const box = await menu.boundingBox();
    const aside = await drawer.boundingBox();
    expect(box.x - aside.x).toBeLessThanOrEqual(12);
    expect(aside.x + aside.width - (box.x + box.width)).toBeLessThanOrEqual(12);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    await page.evaluate(() => {
      window.searchRequests = 0;
      window.addEventListener("agentpier:open-search", () => window.searchRequests++);
    });
    await first.click();
    await expect(menu).toBeHidden();
    expect(await page.evaluate(() => window.searchRequests)).toBe(1);
    // Escape closes the menu first, then the drawer.
    await trigger(page).click();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(drawer).toHaveClass(/open/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });
});
