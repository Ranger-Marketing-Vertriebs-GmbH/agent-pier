import { navigateTo } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
async function fixture(page, { delay = 0, shellFirst = false, extraSessions = [] } = {}) {
  const accounts = [
    { id: "local-codex", name: "Codex Lokal", tool: "codex", kind: "local" },
    { id: "work-claude", name: "Arbeit", tool: "claude", kind: "managed" },
  ];
  const shell = { id: "local-shell", name: "Shell Lokal", tool: "shell", kind: "local" };
  if (shellFirst) accounts.unshift(shell);
  else accounts.push(shell);
  const session = {
    id: "nav-demo",
    name: "Navigation testen",
    tool: "codex",
    accountId: accounts[0].id,
    cwd: "/tmp/demo",
    status: "running",
  };
  const calls = [];
  let first = true;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    calls.push({ path, method: req.method() });
    let data = {};
    if (path === "/api/state") {
      if (first && delay) await new Promise((r) => setTimeout(r, delay));
      first = false;
      data = {
        accounts,
        sessions: [session, ...extraSessions],
        tools: [{ id: "codex", name: "Codex", installed: true }],
        home: "/tmp",
        remoteUrl: null,
      };
    } else if (path.endsWith("/chat"))
      data = {
        availability: "ready",
        messages: [{ id: "one", role: "assistant", text: "Direkt geöffneter Verlauf" }],
        tasks: [],
      };
    else if (path.endsWith("/models"))
      data = { currentModel: "Testmodell", picker: null, pending: false };
    else if (path.endsWith("/screen")) data = { text: "Native Ausgabe" };
    else if (path.endsWith("/extensions"))
      data = {
        mcp: { servers: [], path: "/tmp/config" },
        skills: { items: [], note: "Skills", installPath: "/tmp/skills" },
      };
    else if (path.endsWith("/plugins"))
      data = {
        available: true,
        capabilities: {},
        installed: [],
        marketplaces: [],
        catalog: [],
      };
    else if (path === "/api/repositories") data = { credentials: [], projects: [] };
    await route.fulfill({ json: data });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (ws) =>
    ws.send(JSON.stringify({ type: "output", data: "Native Ausgabe\r\n" })),
  );
  return calls;
}
test("session deep link waits for state, reloads its tab and Back preserves the draft", async ({
  page,
}) => {
  const calls = await fixture(page, { delay: 500 });
  await page.goto(base + "/sessions/nav-demo/chat");
  await expect(page).toHaveURL(/\/sessions\/nav-demo\/chat$/);
  await expect(page.getByLabel("Chatverlauf")).toContainText("Direkt geöffneter Verlauf");
  const draft = page.getByRole("textbox", { name: "Nachricht", exact: true });
  await draft.fill("Entwurf");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/nav-demo\/terminal$/);
  await page.goBack();
  await expect(draft).toBeVisible();
  await expect(draft).toHaveValue("Entwurf");
  await page.goForward();
  await expect(page.getByLabel("Interaktives Terminal")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Interaktives Terminal")).toBeVisible();
  expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
});
test("Shell profile deep links are rejected and never become the profile navigation default", async ({
  page,
}) => {
  const calls = await fixture(page, { shellFirst: true });
  for (const section of ["extensions", "plugins"]) {
    await page.goto(`${base}/${section}/local-shell`);
    await expect(
      page.getByRole("heading", { name: "Profil nicht gefunden" }),
    ).toBeVisible();
    await expect(page).toHaveURL(`${base}/${section}/local-shell`);
  }
  await navigateTo(page, "MCP & Skills");
  await expect(page).toHaveURL(/\/extensions\/local-codex$/);
  await expect(page.getByRole("combobox", { name: "CLI-Profil" })).toHaveValue(
    "local-codex",
  );
  await expect(
    page
      .getByRole("combobox", { name: "CLI-Profil" })
      .locator('option[value="local-shell"]'),
  ).toHaveCount(0);
  await navigateTo(page, "Plugins & Marketplace");
  await expect(page).toHaveURL(/\/plugins\/local-codex$/);
  await expect(
    page
      .getByRole("combobox", { name: "CLI-Profil" })
      .locator('option[value="local-shell"]'),
  ).toHaveCount(0);
  expect(
    calls.filter((call) => call.path.startsWith("/api/accounts/local-shell/")),
  ).toEqual([]);
});
test("profile deep links and navigation survive reload and history", async ({ page }) => {
  await fixture(page);
  await page.goto(base + "/extensions/work-claude");
  await expect(page.getByRole("combobox", { name: "CLI-Profil" })).toHaveValue(
    "work-claude",
  );
  await page.getByRole("combobox", { name: "CLI-Profil" }).selectOption("local-codex");
  await expect(page).toHaveURL(/\/extensions\/local-codex$/);
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "CLI-Profil" })).toHaveValue(
    "work-claude",
  );
  await navigateTo(page, "Plugins & Marketplace");
  await expect(page).toHaveURL(/\/plugins\/work-claude$/);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "CLI-Profil" })).toHaveValue(
    "work-claude",
  );
  await navigateTo(page, "Konten");
  await expect(page).toHaveURL(/\/accounts$/);
  await navigateTo(page, "Repositories");
  await expect(page).toHaveURL(/\/repositories$/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Deine Konten" })).toBeVisible();
});
for (const [path, message] of [
  ["/sessions/missing/chat", "Sitzung nicht gefunden"],
  ["/extensions/missing", "Profil nicht gefunden"],
  ["/unknown-page", "Seite nicht gefunden"],
])
  test(`missing route is explicit and does not create sessions: ${path}`, async ({
    page,
  }) => {
    const calls = await fixture(page);
    await page.goto(base + path);
    await expect(page.getByRole("heading", { name: message })).toBeVisible();
    await expect(page).toHaveURL(base + path);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
test("legacy mobile session links normalize once and use the reader", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.goto(base + "/#nav-demo");
  await expect(page).toHaveURL(/\/sessions\/nav-demo\/chat$/);
  await expect(page.getByLabel("Chatverlauf")).toBeVisible();
});
for (const [path, heading] of [
  ["/accounts", "Deine Konten"],
  ["/repositories", "Deine Repositories"],
  ["/agentbus", "AgentBus"],
])
  test(`page reload retains ${path}`, async ({ page }) => {
    const calls = await fixture(page);
    await page.goto(base + path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
test("AgentBus history restores project and page through reload and Back/Forward without consuming messages", async ({
  page,
}) => {
  const calls = await fixture(page),
    reads = [];
  await page.route("**/api/agentbus**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    calls.push({ path: url.pathname, method: req.method() });
    if (url.pathname === "/api/agentbus")
      return route.fulfill({
        json: {
          version: "test",
          projects: [
            { id: "project-one", name: "Eins", cwd: "/tmp/one", sessions: [] },
            { id: "project-two", name: "Zwei", cwd: "/tmp/two", sessions: [] },
          ],
        },
      });
    const projectId = url.pathname.split("/")[4],
      page = Number(url.searchParams.get("page") || 1);
    reads.push({ projectId, page });
    await route.fulfill({
      json: {
        projectId,
        page,
        pageSize: 20,
        total: 60,
        items: [
          {
            id: `${projectId}-${page}`,
            from: { name: "Sender", tool: "codex" },
            to: { name: "Empfänger", tool: "claude" },
            text: `Verlauf ${projectId} Seite ${page}`,
            createdAt: "2026-09-06T10:00:00Z",
            status: "pending",
          },
        ],
      },
    });
  });
  await page.goto(base + "/agentbus/messages/project-two?page=2");
  await expect(
    page.getByRole("tab", { name: "Nachrichten", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("combobox", { name: "AgentBus-Projekt" })).toHaveValue(
    "project-two",
  );
  await expect(
    page.getByText("Verlauf project-two Seite 2", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Verlauf project-two Seite 2", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "AgentBus-Nachrichten: Nächste Seite" }).click();
  await expect(page).toHaveURL(/\/agentbus\/messages\/project-two\?page=3$/);
  await page.goBack();
  await expect(
    page.getByText("Verlauf project-two Seite 2", { exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByText("Verlauf project-two Seite 3", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "AgentBus-Projekt" })
    .selectOption("project-one");
  await expect(page).toHaveURL(/\/agentbus\/messages\/project-one$/);
  await page.getByRole("tab", { name: "Status", exact: true }).click();
  await expect(page).toHaveURL(/\/agentbus$/);
  await page.goBack();
  await expect(
    page.getByText("Verlauf project-one Seite 1", { exact: true }),
  ).toBeVisible();
  await page.goto(base + "/agentbus/messages?page=2");
  await expect(page).toHaveURL(/\/agentbus\/messages\/project-one\?page=2$/);
  await expect(
    page.getByText("Verlauf project-one Seite 2", { exact: true }),
  ).toBeVisible();
  expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  expect(reads.every((read) => read.page > 0)).toBe(true);
});

test("mobile navigation waits for the authenticated workspace to mount", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseStatus;
  const statusReady = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  await page.route("**/auth/status", async (route) => {
    await statusReady;
    await route.fulfill({ json: { configured: true, authenticated: true } });
  });
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: { accounts: [], sessions: [], tools: [], home: "/fixture" },
    }),
  );
  await page.goto(base);
  await expect(page.locator(".login-page")).toBeVisible();
  // Begin navigation while the workspace is absent, as on a slow auth response.
  const navigation = navigateTo(page, "Übersicht");
  await page.waitForTimeout(100);
  releaseStatus();
  await navigation;
  await expect(
    page.getByRole("heading", { name: "Dein Terminal. Überall." }),
  ).toBeVisible();
});

for (const locale of ["de-DE", "en-GB"]) {
  test(`desktop session switching remembers views and respects explicit links (${locale})`, async ({
    page,
  }) => {
    await page.addInitScript(
      (language) => localStorage.setItem("agentpier-language", language.slice(0, 2)),
      locale,
    );
    await fixture(page, {
      extraSessions: [
        {
          id: "second",
          name: "Second session",
          tool: "claude",
          accountId: "work-claude",
          cwd: "/tmp/second",
          status: "running",
        },
        {
          id: "shell",
          name: "Shell session",
          tool: "shell",
          accountId: "local-shell",
          cwd: "/tmp",
          status: "running",
        },
      ],
    });
    await page.goto(base + "/sessions/nav-demo/chat");
    const select = (name) =>
      page.locator(".sidebar").getByRole("button", { name, exact: false }).click();
    await select("Second session");
    await expect(page).toHaveURL(/\/sessions\/second\/chat$/);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await select("Navigation testen");
    await expect(page).toHaveURL(/\/sessions\/nav-demo\/chat$/);
    await select("Shell session");
    await expect(page).toHaveURL(/\/sessions\/shell\/terminal$/);
    await select("Navigation testen");
    await expect(page).toHaveURL(/\/sessions\/nav-demo\/chat$/);
    await page.reload();
    await select("Second session");
    await expect(page).toHaveURL(/\/sessions\/second\/terminal$/);
    await select("Navigation testen");
    await expect(page).toHaveURL(/\/sessions\/nav-demo\/chat$/);
    await page.goto(base + "/sessions/nav-demo/terminal");
    await expect(page).toHaveURL(/\/sessions\/nav-demo\/terminal$/);
    await select("Second session");
    await select("Navigation testen");
    await expect(page).toHaveURL(/\/sessions\/nav-demo\/terminal$/);
  });
}
