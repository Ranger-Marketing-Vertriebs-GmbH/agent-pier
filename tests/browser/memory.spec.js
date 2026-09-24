import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

// The Projects hub hosting the knowledge tab also reads repositories, AgentBus and runs.
function hubRequest(path) {
  if (path === "/api/repositories") return { credentials: [], projects: [] };
  if (path === "/api/agentbus") return { version: "test", projects: [] };
  if (path === "/api/pipeline-runs") return { runs: [], total: 0, page: 1, pageSize: 20 };
  return null;
}

async function fixture(page) {
  const project = {
    id: "project-one",
    name: "AgentPier",
    cwd: "/workspace/agentpier",
    kind: "repository",
    entryCount: 1,
  };
  let entry = {
    id: "note-one",
    projectId: project.id,
    title: "Build command",
    content: "Run npm test.",
    revision: 1,
    archived: false,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    provenance: {
      kind: "session",
      tool: "codex",
      sessionId: "fixture",
      accountId: "local-codex",
    },
  };
  let conflict = false;
  const calls = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    calls.push({ method, path: url.pathname });
    let data;
    if (url.pathname === "/api/state")
      data = {
        tools: [],
        utilities: [],
        accounts: [],
        sessions: [],
        home: "/workspace",
        defaultCwd: "/workspace",
      };
    else if (url.pathname === "/api/memory/projects")
      data = method === "POST" ? project : { projects: [project] };
    else if (url.pathname.endsWith("/revisions"))
      data = { items: [entry], page: 1, pageSize: 20, total: 1 };
    else if (url.pathname.endsWith("/archive")) {
      entry = { ...entry, ...request.postDataJSON(), revision: entry.revision + 1 };
      data = entry;
    } else if (url.pathname.endsWith("/entries/note-one")) {
      if (method === "PATCH") {
        if (conflict) {
          conflict = false;
          entry = { ...entry, revision: 2, content: "Updated by another agent." };
          await route.fulfill({
            status: 409,
            json: {
              error: "Memory wurde geändert. Bitte vor dem Speichern neu laden.",
              messageKey: "memory.changed",
            },
          });
          return;
        }
        entry = { ...entry, ...request.postDataJSON(), revision: entry.revision + 1 };
      }
      data = entry;
    } else if (url.pathname.endsWith("/entries")) {
      if (method === "POST") {
        entry = { ...entry, ...request.postDataJSON(), revision: 1 };
        data = entry;
      } else {
        const visible =
          entry.archived === (url.searchParams.get("archived") === "true") &&
          (!url.searchParams.get("q") || entry.title.includes(url.searchParams.get("q")));
        data = {
          projectId: project.id,
          items: visible ? [entry] : [],
          page: 1,
          pageSize: 20,
          total: visible ? 1 : 0,
        };
      }
    } else if (hubRequest(url.pathname)) data = hubRequest(url.pathname);
    else throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    await route.fulfill({
      status: method === "POST" && !url.pathname.endsWith("/archive") ? 201 : 200,
      json: data,
    });
  });
  return {
    calls,
    conflict: () => {
      conflict = true;
    },
  };
}

test("project memory deep links support conflict recovery, revisions, archive and restore", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(baseURL + "/memory/project-one?q=Build");
  await expect(page).toHaveURL(`${baseURL}/projects/project-one?tab=knowledge&q=Build`);
  await expect(page.getByRole("heading", { name: "AgentPier", level: 2 })).toBeVisible();
  await expect(
    page.getByRole("tab", { name: /^Projektwissen/, selected: true }),
  ).toBeVisible();
  await page.getByText("Build command").click();
  await page.getByRole("button", { name: "Bearbeiten: Build command" }).click();
  const content = page.getByRole("textbox", { name: "Inhalt", exact: true });
  await content.fill("My unsaved draft");
  state.conflict();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Memory wurde geändert");
  await expect(content).toHaveValue("My unsaved draft");
  await page.getByRole("button", { name: "Aktuellen Stand laden" }).click();
  await expect(content).toHaveValue("Updated by another agent.");
  await content.fill("Run npm run check.");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Versionen: Build command" }).click();
  await expect(page.getByRole("heading", { name: "Versionsverlauf" })).toBeVisible();
  await page.getByRole("button", { name: "Dialog schließen" }).click();
  await page.getByRole("button", { name: "Archivieren: Build command" }).click();
  await expect(page.getByText("Noch keine Einträge.")).toBeVisible();
  await page.getByRole("button", { name: /^Archiv ·/ }).click();
  await expect(page).toHaveURL(/archived=1/);
  await page.reload();
  await page.getByText("Build command").click();
  await page.getByRole("button", { name: "Wiederherstellen: Build command" }).click();
  await page.getByRole("button", { name: /^Aktiv ·/ }).click();
  // The row stayed expanded across the archive/restore/segment switch above.
  await expect(
    page.getByRole("button", { name: "Bearbeiten: Build command" }),
  ).toBeVisible();
});

test("clicking a knowledge entry expands it and reveals its actions", async ({
  page,
}) => {
  await fixture(page);
  await page.goto(baseURL + "/projects/project-one?tab=knowledge");
  const toggle = page.getByRole("button", { name: /^Build command/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("button", { name: "Bearbeiten: Build command" }),
  ).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("button", { name: "Bearbeiten: Build command" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Versionen: Build command" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Archivieren: Build command" }),
  ).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("button", { name: "Bearbeiten: Build command" }),
  ).toHaveCount(0);
});

async function newEntryFixture(page) {
  const project = { id: "project-one", name: "AgentPier", cwd: "/workspace/agentpier" };
  const entries = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    let data;
    if (url.pathname === "/api/state")
      data = { tools: [], accounts: [], sessions: [], home: "/workspace" };
    else if (url.pathname === "/api/memory/projects" && method === "GET")
      data = {
        projects: [
          { ...project, entryCount: entries.filter((item) => !item.archived).length },
        ],
      };
    else if (url.pathname.endsWith("/entries") && method === "POST") {
      const body = request.postDataJSON();
      const created = {
        id: `e${entries.length + 1}`,
        title: body.title,
        content: body.content,
        revision: 1,
        archived: false,
        provenance: { kind: "user" },
      };
      entries.push(created);
      data = created;
    } else if (url.pathname.endsWith("/entries")) {
      const wantArchived = url.searchParams.get("archived") === "true";
      const items = entries.filter((item) => item.archived === wantArchived);
      data = { projectId: project.id, items, page: 1, pageSize: 20, total: items.length };
    } else if (hubRequest(url.pathname)) data = hubRequest(url.pathname);
    else throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    await route.fulfill({ status: method === "POST" ? 201 : 200, json: data });
  });
}

test("creating a knowledge entry updates the hub's tab counter", async ({ page }) => {
  await newEntryFixture(page);
  await page.goto(baseURL + "/projects/project-one?tab=knowledge");
  await expect(page.getByRole("tab", { name: /^Projektwissen/ })).toContainText("0");
  await page.getByRole("button", { name: "Neuer Eintrag" }).click();
  await page.getByLabel("Titel", { exact: true }).fill("Second note");
  await page.getByRole("textbox", { name: "Inhalt", exact: true }).fill("More context.");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^Projektwissen/ })).toContainText("1");
});

async function unregisteredFixture(page) {
  const repository = {
    id: "r1",
    name: "Unlinked",
    url: "",
    path: "/work/unlinked",
    credentialId: "",
  };
  let registered = null;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    let data;
    if (url.pathname === "/api/state")
      data = { tools: [], accounts: [], sessions: [], home: "/work" };
    else if (url.pathname === "/api/repositories")
      data = { credentials: [], projects: [repository] };
    else if (url.pathname === "/api/agentbus") data = { version: "test", projects: [] };
    else if (url.pathname === "/api/pipeline-runs")
      data = { runs: [], total: 0, page: 1, pageSize: 20 };
    else if (url.pathname === "/api/memory/projects" && method === "POST") {
      registered = {
        id: "m1",
        name: "Unlinked",
        cwd: request.postDataJSON().cwd,
        kind: "directory",
        entryCount: 0,
      };
      data = registered;
    } else if (url.pathname === "/api/memory/projects")
      data = { projects: registered ? [registered] : [] };
    else if (url.pathname.endsWith("/entries"))
      data = {
        projectId: registered?.id || "",
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
      };
    else throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    await route.fulfill({ status: method === "POST" ? 201 : 200, json: data });
  });
}

test("a project without stored knowledge can be registered from the tab", async ({
  page,
}) => {
  await unregisteredFixture(page);
  await page.goto(baseURL + "/projects/r1?tab=knowledge");
  await expect(page.getByRole("button", { name: "Projekt hinzufügen" })).toBeVisible();
  await page.getByRole("button", { name: "Projekt hinzufügen" }).click();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=knowledge$/);
  await expect(page.getByRole("button", { name: "Neuer Eintrag" })).toBeVisible();
});

test.describe("English knowledge tab", () => {
  test.use({ locale: "en-GB" });
  test("labels are translated", async ({ page }) => {
    await fixture(page);
    await page.goto(baseURL + "/projects/project-one?tab=knowledge");
    await expect(page.getByRole("textbox", { name: "Search knowledge" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Active ·/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Archive ·/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "New entry" })).toBeVisible();
    await expect(
      page.getByText(/Git worktrees share repository knowledge/),
    ).toBeVisible();
  });
});

test("mobile project memory creates notes without horizontal overflow or implicit writes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.goto(baseURL + "/memory/project-one");
  await expect(page.getByRole("button", { name: "Neuer Eintrag" })).toBeVisible();
  expect(state.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  await page.getByRole("button", { name: "Neuer Eintrag" }).click();
  await page.getByLabel("Titel", { exact: true }).fill("Mobile note");
  await page
    .getByRole("textbox", { name: "Inhalt", exact: true })
    .fill("A shared finding.");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await page.getByText("Mobile note").click();
  await expect(
    page.getByRole("button", { name: "Bearbeiten: Mobile note" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/agentpier-memory-mobile.png", fullPage: true });
});

async function pagedFixture(page) {
  const project = { id: "paged-project", name: "Paged project", cwd: "/fixture/paged" };
  const entry = {
    id: "last-note",
    title: "Last note",
    content: "Current note",
    revision: 21,
    archived: false,
    provenance: { kind: "user" },
  };
  const controls = {
    total: 21,
    historyError: false,
    holdHistory: false,
    releaseHistory: null,
    holdEntries: false,
    releaseEntries: null,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      requestedPage = Number(url.searchParams.get("page") || 1);
    let data;
    if (url.pathname === "/api/state")
      data = { tools: [], accounts: [], sessions: [], home: "/fixture" };
    else if (url.pathname === "/api/memory/projects") data = { projects: [project] };
    else if (url.pathname.endsWith("/archive")) {
      controls.total = 20;
      data = { ...entry, archived: true, revision: 22 };
    } else if (url.pathname.endsWith("/revisions")) {
      if (requestedPage === 2 && controls.holdHistory)
        await new Promise((resolve) => {
          controls.releaseHistory = resolve;
        });
      if (requestedPage === 2 && controls.historyError)
        return route.fulfill({
          status: 503,
          json: { error: "History temporarily unavailable" },
        });
      data = {
        items: [
          {
            ...entry,
            content: requestedPage === 1 ? "First history page" : "Second history page",
          },
        ],
        page: requestedPage,
        pageSize: 20,
        total: 21,
      };
    } else if (url.pathname.endsWith("/entries")) {
      const total = controls.total;
      if (controls.holdEntries && requestedPage > 1)
        await new Promise((resolve) => {
          controls.releaseEntries = resolve;
        });
      data = {
        projectId: project.id,
        items: (requestedPage - 1) * 20 < total ? [entry] : [],
        page: requestedPage,
        pageSize: 20,
        total,
      };
    } else if (hubRequest(url.pathname)) data = hubRequest(url.pathname);
    else throw new Error(`Unexpected paged memory request: ${url.pathname}`);
    await route.fulfill({ json: data });
  });
  return controls;
}

test("archiving the last entry on a page reloads the preceding page and replaces the obsolete URL", async ({
  page,
}) => {
  await pagedFixture(page);
  await page.goto(baseURL + "/projects");
  const list = page.getByRole("navigation", { name: "Projekte" });
  await list.getByRole("button", { name: /^Paged project/ }).click();
  await page.getByRole("tab", { name: /^Projektwissen/ }).click();
  await expect(page).toHaveURL(/\/projects\/paged-project\?tab=knowledge$/);
  await page.evaluate(() => {
    history.pushState(null, "", "/projects/paged-project?tab=knowledge&page=2");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByText("Last note").click();
  await page.getByRole("button", { name: "Archivieren: Last note" }).click();
  await expect(page).toHaveURL(/\/projects\/paged-project\?tab=knowledge$/);
  await expect(page.getByText("Last note")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/paged-project\?tab=knowledge$/);
});

test("an excessive memory page normalizes only after its matching result arrives", async ({
  page,
}) => {
  const controls = await pagedFixture(page);
  controls.holdEntries = true;
  await page.goto(baseURL + "/memory/paged-project?page=99");
  await expect.poll(() => Boolean(controls.releaseEntries)).toBe(true);
  await expect(page).toHaveURL(/page=99/);
  controls.holdEntries = false;
  controls.releaseEntries();
  await expect(page).toHaveURL(/page=2$/);
  await expect(page.getByText("Last note")).toBeVisible();
});

test("an obsolete memory page result cannot replace a newer search route", async ({
  page,
}) => {
  const controls = await pagedFixture(page);
  controls.holdEntries = true;
  await page.goto(baseURL + "/memory/paged-project?page=99");
  await expect.poll(() => Boolean(controls.releaseEntries)).toBe(true);
  await page.getByRole("textbox", { name: "Wissen suchen" }).fill("new filter");
  await page.getByRole("button", { name: "Wissen suchen", exact: true }).click();
  await expect(page).toHaveURL(/q=new\+filter$/);
  await expect(page.getByText("Last note")).toBeVisible();
  controls.releaseEntries();
  await expect(page).toHaveURL(/q=new\+filter$/);
});

test("history hides earlier pages while loading and retries the requested page after failure", async ({
  page,
}) => {
  const controls = await pagedFixture(page);
  await page.goto(baseURL + "/memory/paged-project");
  await page.getByText("Last note").click();
  await page.getByRole("button", { name: "Versionen: Last note" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("First history page");
  controls.holdHistory = true;
  controls.historyError = true;
  await page.getByRole("button", { name: "Versionsverlauf: nächste Seite" }).click();
  await expect.poll(() => Boolean(controls.releaseHistory)).toBe(true);
  await expect(dialog).not.toContainText("First history page");
  await expect(dialog.getByRole("status")).toContainText("Einen Moment");
  controls.holdHistory = false;
  controls.releaseHistory();
  await expect(dialog.getByRole("alert")).toContainText(
    "History temporarily unavailable",
  );
  await expect(dialog).not.toContainText("First history page");
  controls.historyError = false;
  await dialog.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(dialog).toContainText("Second history page");
  await expect(dialog).toContainText("Seite 2 / 2");
});
