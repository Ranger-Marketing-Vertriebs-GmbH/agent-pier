import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";

const repositoryPath = "/work/agent-pier";

const hubRun = (id, projectId, status) => ({
  id,
  projectId,
  status,
  pipelineName: "Entwicklungsablauf",
  task: `Task ${id}`,
  cwd: projectId === "m1" ? repositoryPath : "/work/notes",
  createdAt: "2026-09-10T05:00:00Z",
  nodes: [{ id: "n1", status: "pending", profileSnapshot: { name: "Planer" } }],
  currentNodeId: "n1",
  actions: [],
});
const hubRuns = [
  hubRun("a", "m1", "awaiting-human"),
  hubRun("r2", "m1", "running"),
  hubRun("r3", "m1", "completed"),
  hubRun("f1", "m2", "failed"),
  hubRun("f2", "m2", "failed"),
];

async function hubFixture(page, controls = {}) {
  const calls = [];
  const memoryProjects = [
    {
      id: "m1",
      name: "agent-pier",
      cwd: repositoryPath,
      kind: "repository",
      entryCount: 4,
    },
    { id: "m2", name: "notes", cwd: "/work/notes", kind: "directory", entryCount: 0 },
  ];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    calls.push({ method, path: url.pathname, search: url.search });
    let json = {};
    if (controls.failMemory && url.pathname === "/api/memory/projects")
      return route.fulfill({ status: 503, json: { error: "Wissen nicht erreichbar" } });
    if (url.pathname === "/api/state")
      json = {
        tools: [{ id: "codex", name: "Codex", installed: true }],
        accounts: [{ id: "local-codex", name: "Lokal", tool: "codex", kind: "local" }],
        sessions: [
          {
            id: "s1",
            name: "Hub fixture session",
            tool: "codex",
            accountId: "local-codex",
            cwd: `${repositoryPath}/`,
            status: "running",
            createdAt: new Date(Date.now() - 5 * 60000).toISOString(),
          },
        ],
        home: "/work",
      };
    else if (url.pathname === "/api/repositories")
      json = {
        credentials: [
          { id: "c1", name: "Arbeit", host: "https://github.com", hasSecret: true },
        ],
        projects: [
          ...(controls.unregistered
            ? [{ id: "r2", name: "loose", url: "", path: "/work/loose" }]
            : []),
          {
            id: "r1",
            name: "agent-pier",
            url: "https://github.com/acme/agent-pier.git",
            path: repositoryPath,
            credentialId: "c1",
          },
        ],
      };
    else if (url.pathname === "/api/memory/projects" && method === "POST") {
      const body = request.postDataJSON();
      const added = {
        id: "m3",
        name: "added",
        cwd: body.cwd,
        kind: "directory",
        entryCount: 0,
      };
      memoryProjects.push(added);
      json = added;
    } else if (url.pathname === "/api/memory/projects")
      json = { projects: memoryProjects };
    else if (url.pathname === "/api/agentbus")
      json = {
        version: "test",
        projects: [
          {
            id: "b1",
            name: "agent-pier",
            cwd: repositoryPath,
            sessions: [{ id: "s1", name: "Hub fixture session", tool: "codex" }],
          },
        ],
      };
    else if (url.pathname.endsWith("/entries"))
      json = { projectId: "m1", items: [], page: 1, pageSize: 20, total: 0 };
    else if (url.pathname === "/api/repositories/discover")
      json = {
        organizations: [],
        repositories: [],
        total: 0,
        page: 1,
        hasMore: false,
        truncated: false,
      };
    else if (url.pathname === "/api/pipeline-runs" && method === "POST")
      json = { run: { id: "new-run", ...request.postDataJSON() } };
    else if (url.pathname === "/api/pipeline-runs") {
      const status = url.searchParams.get("status"),
        projectId = url.searchParams.get("projectId"),
        page = Number(url.searchParams.get("page") || 1);
      const runs = hubRuns.filter(
        (run) =>
          (!status || run.status === status) &&
          (!projectId || run.projectId === projectId),
      );
      json = {
        runs: runs.slice((page - 1) * 20, page * 20),
        total: runs.length,
        page,
        pageSize: 20,
      };
    } else if (url.pathname.startsWith("/api/pipeline-runs/"))
      json = { run: hubRuns.find((run) => url.pathname.endsWith(`/${run.id}`)) };
    else if (url.pathname === "/api/pipelines")
      json = { pipelines: [{ id: "p1", name: "Entwicklungsablauf" }] };
    await route.fulfill({ json });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", () => {});
  return calls;
}

const projectList = (page, name = "Projekte") =>
  page.getByRole("navigation", { name, exact: true });
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("the hub joins projects, selects the first one and resolves every id space", async ({
  page,
}) => {
  const calls = await hubFixture(page);
  await page.goto(base + "/projects");
  await expect(page).toHaveURL(/\/projects\/m1$/);
  const list = projectList(page);
  await expect(list.getByRole("button")).toHaveCount(2);
  const first = list.getByRole("button", { name: /^agent-pier/ });
  await expect(first).toHaveAttribute("aria-current", "true");
  await expect(first).toContainText("acme/agent-pier");
  await expect(first).toContainText("1 Entscheidung erforderlich");
  await expect(list.getByRole("button", { name: /^notes/ })).toContainText(
    "2 Läufe fehlgeschlagen",
  );
  await expect(page.getByRole("heading", { name: "agent-pier", level: 2 })).toBeVisible();
  await expect(page.getByText("acme/agent-pier · Token Arbeit")).toBeVisible();
  const facts = page.getByRole("definition");
  await expect(facts).toHaveText([
    "github.com/acme/agent-pier",
    "—",
    "Arbeit",
    repositoryPath,
  ]);
  for (const [tab, count] of [
    ["Projektwissen", "4"],
    ["AgentBus", "1"],
    ["Läufe", "3"],
  ])
    await expect(page.getByRole("tab", { name: new RegExp(`^${tab}`) })).toContainText(
      count,
    );
  await expect(page.getByText("Sitzungen · 1")).toBeVisible();
  await expect(page.getByText("Codex · vor 5 Minuten")).toBeVisible();
  const statusCalls = calls.filter(
    (call) => call.path === "/api/pipeline-runs" && call.search.includes("status="),
  );
  expect(statusCalls).toHaveLength(2);

  await page.goto(base + "/projects/r1");
  await expect(page).toHaveURL(/\/projects\/m1$/);
  await page.goto(base + "/projects/b1?tab=agentbus");
  await expect(page).toHaveURL(/\/projects\/m1\?tab=agentbus$/);
  await page.goto(base + "/projects/unknown-project");
  await expect(
    page.getByRole("heading", { name: "Projekt nicht gefunden" }),
  ).toBeVisible();
  const missingText = page.locator(".project-missing p");
  await expect(missingText).toHaveCSS("font-size", "12px");
  await expect(missingText).toHaveCSS("color", "rgb(157, 158, 162)");
  await expect(missingText).not.toHaveCSS("display", "grid");
  await page.getByRole("button", { name: "Alle Projekte" }).last().click();
  await expect(page).toHaveURL(/\/projects\/m1$/);

  await page.getByRole("tab", { name: /^Läufe/ }).click();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=runs$/);
  await expect(page.getByRole("button", { name: /^Lauf öffnen:/ })).toHaveCount(3);
  await page.getByRole("tab", { name: "Übersicht" }).click();
  await page.getByRole("button", { name: "Sitzung Hub fixture session öffnen" }).click();
  await expect(page).toHaveURL(/\/sessions\/s1\//);
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
});

test("a failing source keeps the other projects listed and retry recovers", async ({
  page,
}) => {
  const controls = { failMemory: true };
  await hubFixture(page, controls);
  await page.goto(base + "/projects");
  const list = projectList(page);
  await expect(list.getByRole("button", { name: /^agent-pier/ })).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/r1$/);
  await expect(page.getByRole("alert")).toContainText("Wissen nicht erreichbar");
  await expect(
    page.getByText("Nicht alle Projektquellen konnten geladen werden.", { exact: false }),
  ).toBeVisible();
  controls.failMemory = false;
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(list.getByRole("button")).toHaveCount(2);
  await expect(page).toHaveURL(/\/projects\/m1$/);
});

test("a folder is added through its dialog and opens as project", async ({ page }) => {
  const calls = await hubFixture(page);
  await page.goto(base + "/projects");
  await page.getByRole("button", { name: "Ordner hinzufügen" }).click();
  const dialog = page.getByRole("dialog", { name: "Projekt hinzufügen" });
  const folder = dialog.getByRole("textbox", { name: "Projektordner" });
  await expect(folder).toHaveValue("/work");
  await folder.fill("/work/added");
  await dialog.getByRole("button", { name: "Projekt hinzufügen" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/projects\/m3$/);
  await expect(page.getByRole("heading", { name: "added", level: 2 })).toBeVisible();
  expect(calls.filter((call) => call.method !== "GET")).toEqual([
    { method: "POST", path: "/api/memory/projects", search: "" },
  ]);
});

test("mobile shows the list first, then the detail, and dialogs fit as sheets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await hubFixture(page);
  await page.goto(base + "/projects");
  const list = projectList(page);
  await expect(list.getByRole("button")).toHaveCount(2);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("tablist")).toHaveCount(0);
  expect(await noOverflow(page)).toBe(true);
  await list.getByRole("button", { name: /^agent-pier/ }).click();
  await expect(page).toHaveURL(/\/projects\/m1$/);
  await expect(page.getByRole("heading", { name: "agent-pier", level: 1 })).toBeVisible();
  await expect(list).toBeHidden();
  const launch = page.getByRole("button", { name: "Sitzung in agent-pier starten" });
  const box = await launch.boundingBox();
  expect(Math.round(box.height)).toBe(43);
  expect(Math.round(box.y + box.height)).toBeGreaterThan(780);
  await page.getByRole("tab", { name: /^Läufe/ }).scrollIntoViewIfNeeded();
  expect(await noOverflow(page)).toBe(true);
  await page.getByRole("button", { name: "Alle Projekte" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(list).toBeVisible();

  await page.getByRole("button", { name: "Repository klonen", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Repository klonen" });
  await expect(sheet.getByRole("radiogroup", { name: "Token-Profil" })).toBeVisible();
  await sheet.getByRole("radio", { name: /Arbeit/ }).check();
  const sheetBox = await sheet.boundingBox();
  expect(Math.round(sheetBox.width)).toBe(390);
  expect(Math.round(sheetBox.y + sheetBox.height)).toBe(844);
  expect(await noOverflow(page)).toBe(true);
});

test("the runs tab lists the project's runs with filters bound to the projects URL", async ({
  page,
}) => {
  const calls = await hubFixture(page);
  await page.goto(base + "/projects/m1?tab=runs&page=4");
  await expect(page).toHaveURL(/\/projects\/m1\?tab=runs$/);
  const rows = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: /^Lauf öffnen:/ }) });
  await expect(rows).toHaveCount(3);
  await expect(page.getByRole("columnheader")).toHaveText([
    "Aufgabe",
    "Fortschritt",
    "Status",
    "Aktualisiert",
  ]);
  await expect(page.getByRole("combobox", { name: "Projekt" })).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Pipelines" })).toHaveCount(0);
  const filter = page.getByRole("group", { name: "Status", exact: true });
  await expect(filter.getByRole("button")).toHaveText([
    /^Alle Status\s*3$/,
    /^Entscheidung erforderlich\s*1$/,
    /^Läuft\s*1$/,
    /^Abgeschlossen\s*1$/,
  ]);
  const listCalls = calls.filter(
    (call) =>
      call.path === "/api/pipeline-runs" &&
      call.search.includes("page=") &&
      !call.search.includes("status="),
  );
  expect(listCalls.length).toBeGreaterThan(0);
  expect(listCalls.every((call) => call.search.includes("projectId=m1"))).toBe(true);
  await filter.getByRole("button", { name: /^Läuft/ }).click();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=runs&status=running$/);
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(filter.getByRole("button", { name: /^Läuft/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "Lauf öffnen: Task r2" }).click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/r2$/);
  await page.goBack();
  const progress = await rows.first().locator(".run-table-progress").boundingBox();
  await page.mouse.click(
    progress.x + progress.width / 2,
    progress.y + progress.height / 2,
  );
  await expect(page).toHaveURL(/\/pipelines\/runs\/r2$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=runs&status=running$/);

  await page.getByRole("button", { name: "Lauf starten", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Lauf starten" });
  await expect(
    dialog
      .getByRole("radiogroup", { name: "Projekt" })
      .getByRole("radio", { name: "agent-pier" }),
  ).toBeChecked();
  await expect(dialog.getByLabel("Arbeitsverzeichnis")).toHaveValue(repositoryPath);
  await dialog.getByRole("radio", { name: "Entwicklungsablauf" }).check();
  await dialog.getByLabel("Aufgabe").fill("Hub task");
  await dialog.getByRole("button", { name: "Lauf starten", exact: true }).click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/new-run$/);
});

test("a folder without knowledge project offers registration on the runs tab", async ({
  page,
}) => {
  const calls = await hubFixture(page, { unregistered: true });
  await page.goto(base + "/projects/r2?tab=runs");
  await expect(
    page.getByText("Läufe gehören zu einem Projektordner.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Status" })).toHaveCount(0);
  await page.getByRole("button", { name: "Projekt hinzufügen", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/m3\?tab=runs$/);
  expect(calls.filter((call) => call.method === "POST")).toEqual([
    { method: "POST", path: "/api/memory/projects", search: "" },
  ]);
});

test.describe("English projects hub", () => {
  test.use({ locale: "en-GB" });

  test("labels, hints and dialogs are translated", async ({ page }) => {
    await hubFixture(page);
    await page.goto(base + "/projects");
    await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
    await expect(page.getByText("WORKSPACE / PROJECTS")).toBeVisible();
    const list = projectList(page, "Projects");
    await expect(list.getByRole("button", { name: /^agent-pier/ })).toContainText(
      "1 decision required",
    );
    await expect(list.getByRole("button", { name: /^notes/ })).toContainText(
      "2 runs failed",
    );
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /^Project knowledge/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /^Runs/ })).toBeVisible();
    await expect(page.getByText("Sessions · 1")).toBeVisible();
    await expect(page.getByText("Token profile")).toBeVisible();
    await page.getByRole("button", { name: "Clone repository", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Clone repository" });
    await expect(dialog.getByRole("radio", { name: "No token" })).toBeChecked();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Add folder" }).click();
    await expect(
      page.getByRole("dialog", { name: "Add project" }).getByLabel("Project directory"),
    ).toHaveValue("/work");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await list.getByRole("button", { name: /^notes/ }).click();
    await expect(page.getByText("Local only").first()).toBeVisible();
    await expect(page.getByText("No sessions in this project yet.")).toBeVisible();
    await page.getByRole("tab", { name: /^Runs/ }).click();
    await expect(page.getByRole("button", { name: "Open run: Task f1" })).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Status" }).getByRole("button"),
    ).toHaveText([/^All statuses\s*2$/, /^Failed\s*2$/]);
    await expect(page.getByRole("columnheader")).toHaveText([
      "Task",
      "Progress",
      "Status",
      "Updated",
    ]);
  });
});
