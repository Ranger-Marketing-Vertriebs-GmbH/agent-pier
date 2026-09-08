import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

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
            json: { error: "Memory changed. Reload before saving." },
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
    } else throw new Error(`Unexpected request: ${method} ${url.pathname}`);
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
  await expect(
    page.getByRole("heading", { name: "Projektwissen", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("/workspace/agentpier", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bearbeiten: Build command" }).click();
  const content = page.getByRole("textbox", { name: "Inhalt", exact: true });
  await content.fill("My unsaved draft");
  state.conflict();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Memory changed");
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
  await page.getByRole("button", { name: "Archiv", exact: true }).click();
  await expect(page).toHaveURL(/archived=1/);
  await page.reload();
  await page.getByRole("button", { name: "Wiederherstellen: Build command" }).click();
  await page.getByRole("button", { name: "Aktiv", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Bearbeiten: Build command" }),
  ).toBeVisible();
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
    } else throw new Error(`Unexpected paged memory request: ${url.pathname}`);
    await route.fulfill({ json: data });
  });
  return controls;
}

test("archiving the last entry on a page reloads the preceding page and replaces the obsolete URL", async ({
  page,
}) => {
  await pagedFixture(page);
  await page.goto(baseURL + "/memory");
  await page.getByRole("combobox", { name: "Projekt", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Paged project", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    history.pushState(null, "", "/memory/paged-project?page=2");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByRole("button", { name: "Archivieren: Last note" }).click();
  await expect(page).toHaveURL(/\/memory\/paged-project$/);
  await expect(
    page.getByRole("heading", { name: "Last note", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/memory$/);
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
  await expect(
    page.getByRole("heading", { name: "Last note", exact: true }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("heading", { name: "Last note", exact: true }),
  ).toBeVisible();
  controls.releaseEntries();
  await expect(page).toHaveURL(/q=new\+filter$/);
});

test("history hides earlier pages while loading and retries the requested page after failure", async ({
  page,
}) => {
  const controls = await pagedFixture(page);
  await page.goto(baseURL + "/memory/paged-project");
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
