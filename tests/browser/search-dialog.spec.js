// ⌘K search (handoff §5.9, AC-SR-1, AC-SR-2): the shortcut opens it except in a
// terminal, the code editor or a text field; it finds areas, tabs, agents, old names
// and actions; arrows, Enter and Escape work; the sidebar button and the phone menu
// row open the same dialog.
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { explorerFixture } from "../helpers/file-explorer-browser.js";

const dialog = (page) => page.getByRole("dialog", { name: "Suchen" });
const field = (page) => dialog(page).getByRole("combobox");
const options = (page) => dialog(page).getByRole("option");
const shortcut = (page) => page.keyboard.press("ControlOrMeta+k");

// Agents on with one agent, "Scout".
async function agentsOn(page) {
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
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [
            {
              id: "scout",
              name: "Scout",
              model: { connectionId: "router", modelId: "m" },
              capabilities: { memory: true },
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

async function openWithShortcut(page) {
  await shortcut(page);
  await expect(dialog(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
}

test("⌘K finds areas, tabs, agents, old names and actions and navigates by keyboard", async ({
  page,
}) => {
  await agentsOn(page);
  await page.route("**/api/ssh-accesses", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            accesses: [
              {
                id: "prod",
                name: "prod-db",
                host: "db.example.com",
                username: "deploy",
                port: 22,
                type: "ssh",
                lastTest: null,
              },
            ],
          },
        })
      : route.fallback(),
  );
  await page.goto(baseURL + "/projects");
  await expect(page.locator(".sidebar")).toBeVisible();
  await openWithShortcut(page);
  // A blank query suggests the areas and the actions.
  await expect(dialog(page).getByRole("group", { name: "Seiten" })).toBeVisible();
  await expect(dialog(page).getByRole("group", { name: "Aktionen" })).toBeVisible();

  // An area's subpage, with its path; arrows move, Enter opens.
  await field(page).fill("ssh");
  const first = options(page).first();
  await expect(first).toContainText("SSH/SFTP-Zugänge");
  await expect(first).toContainText("Zugänge › SSH/SFTP-Zugänge");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(field(page)).toHaveAttribute(
    "aria-activedescendant",
    (await options(page).nth(1).getAttribute("id")) || "",
  );
  await page.keyboard.press("ArrowUp");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/connections\?section=ssh$/);

  // The connection names loaded on the first open: an SSH access by its host.
  await openWithShortcut(page);
  await field(page).fill("db.example");
  await expect(options(page).first()).toContainText("prod-db");

  // An old name leads to the new place and says it is the old one.
  await field(page).fill("Einstellungen › Zugriff › SSH-Zugänge");
  await expect(options(page).first()).toContainText("SSH/SFTP-Zugänge");
  await expect(options(page).first()).toContainText(
    "früher Einstellungen › Zugriff › SSH-Zugänge",
  );

  // English labels match in the German UI too; a tab of the agents hub.
  await field(page).fill("Runtime");
  await expect(options(page).first()).toContainText("Laufzeit");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/agents\?tab=runtime$/);

  // An agent's tab, under "An Agenten"; an old tab name finds the new tab.
  await openWithShortcut(page);
  await field(page).fill("Scout Profil");
  const agents = dialog(page).getByRole("group", { name: "An Agenten" });
  await expect(agents.getByRole("option").first()).toContainText("Scout · Identität");
  await expect(agents.getByRole("option").first()).toContainText("früher Scout · Profil");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/agents\/scout\/settings\?tab=identity$/);

  // Nothing found: the state says so and offers to clear the search.
  await openWithShortcut(page);
  await field(page).fill("zzqqxx");
  await expect(dialog(page)).toContainText("Nichts gefunden für „zzqqxx“");
  await expect(options(page)).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Suche zurücksetzen" }).click();
  await expect(field(page)).toHaveValue("");
  await expect(options(page).first()).toBeVisible();

  // Actions: a route action and a page action that opens the page's own dialog.
  await field(page).fill("MCP-Server hinzufügen");
  await dialog(page)
    .getByRole("option", { name: /MCP-Server hinzufügen/ })
    .click();
  await expect(page).toHaveURL(/\/connections\?section=mcp-servers&item=new/);
  await openWithShortcut(page);
  await field(page).fill("SSH-Schlüssel hinzufügen");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/connections\?section=ssh$/);
  await expect(
    page.getByRole("dialog", { name: "SSH-Schlüssel hinzufügen" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await openWithShortcut(page);
  await field(page).fill("neue session");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Neue Session" })).toBeVisible();
});

test("Escape closes the search and returns the focus; the sidebar button opens it", async ({
  page,
}) => {
  await page.goto(baseURL + "/projects");
  const menu = page.locator(".sidebar .sidebar-menu-button");
  await menu.focus();
  await openWithShortcut(page);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(menu).toBeFocused();
  // AC-SR-2: the sidebar search button opens the same dialog.
  const button = page.locator(".sidebar").getByRole("button", { name: "Suchen (⌘K)" });
  await button.click();
  await expect(dialog(page)).toBeVisible();
  await field(page).fill("Fernzugriff");
  await expect(options(page).first()).toContainText("Einstellungen › Fernzugriff");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("in English the search speaks English and still finds German names", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(baseURL + "/projects");
  await expect(page.locator(".sidebar")).toBeVisible();
  await shortcut(page);
  const search = page.getByRole("dialog", { name: "Search" });
  await expect(search).toBeVisible();
  await expect(search.getByRole("group", { name: "Pages" })).toBeVisible();
  await search
    .getByRole("combobox", { name: "Search settings, agents or actions" })
    .fill("Geheimnisse");
  await expect(search.getByRole("option").first()).toContainText("Connections › Secrets");
  await search.getByRole("combobox").fill("zzqqxx");
  await expect(search).toContainText("Nothing found for “zzqqxx”");
  await expect(search.getByRole("button", { name: "Clear search" })).toBeVisible();
});

test("the shortcut stays with text fields and the terminal", async ({ page }) => {
  const session = {
    id: "search-terminal",
    name: "Suchtest",
    tool: "claude",
    accountId: "local-claude",
    cwd: "/fixture",
    status: "running",
  };
  await page.route("**/api/**", (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    if (endpoint === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "claude", name: "Claude Code", installed: true }],
          accounts: [
            { id: "local-claude", name: "Claude Lokal", tool: "claude", kind: "local" },
          ],
          sessions: [session],
          home: "/fixture",
        },
      });
    if (endpoint.endsWith("/models"))
      return route.fulfill({
        json: { currentModel: null, picker: null, pending: false },
      });
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (socket) => {
    socket.onMessage(() => {});
    socket.send(JSON.stringify({ type: "output", data: "bereit\r\n❯ " }));
  });
  await page.goto(baseURL + "/sessions/search-terminal/terminal");
  await expect(page.locator(".xterm-rows")).toContainText("bereit");
  await page.locator(".xterm").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await shortcut(page);
  await expect(dialog(page)).toHaveCount(0);
  // Outside the terminal the shortcut opens the search.
  await page.locator(".sidebar .sidebar-menu-button").focus();
  await openWithShortcut(page);
  // Inside the search's own field the shortcut keeps the search open.
  await shortcut(page);
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  // A text field elsewhere keeps the shortcut too.
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "search-probe";
    document.querySelector("main").prepend(input);
  });
  await page.locator("#search-probe").focus();
  await shortcut(page);
  await expect(dialog(page)).toHaveCount(0);
});

test("the shortcut stays with the code editor", async ({ page }) => {
  await explorerFixture(page);
  const path = "/home/test/readme.txt";
  await page.route("**/api/files/text**", (route) =>
    route.fulfill({
      json: {
        path,
        resolvedPath: path,
        text: "Hallo\n",
        bom: false,
        lineEnding: "lf",
        readOnly: false,
        revision: `d1:${"1".repeat(64)}`,
        metadataRevision: `e1:${"1".repeat(64)}`,
      },
    }),
  );
  await page.goto(
    `${baseURL}/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`,
  );
  await page.getByRole("button", { name: "Im Editor öffnen", exact: true }).click();
  await page.locator(".cm-content").click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await shortcut(page);
  await expect(dialog(page)).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("the menu's search row opens the same search; a result closes the drawer", async ({
    page,
  }) => {
    await page.goto(baseURL + "/projects");
    await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
    const drawer = page.locator(".sidebar");
    await expect(drawer).toHaveClass(/open/);
    await page.locator(".sidebar .sidebar-menu-button").click();
    await page.locator("#sidebar-menu").getByRole("button", { name: "Suchen" }).click();
    await expect(dialog(page)).toBeVisible();
    // Escape closes only the search; the drawer stays.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(drawer).toHaveClass(/open/);
    await page.locator(".sidebar .sidebar-menu-button").click();
    await page.locator("#sidebar-menu").getByRole("button", { name: "Suchen" }).click();
    await field(page).fill("Geheimnisse");
    await expect(options(page).first()).toContainText("Zugänge › Geheimnisse");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await options(page).first().click();
    await expect(page).toHaveURL(/\/connections\?section=secrets$/);
    await expect(dialog(page)).toHaveCount(0);
    await expect(drawer).not.toHaveClass(/open/);
  });
});
