import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

// Deleting a project from the projects page, in English. Every /api/project-deletion
// route is answered here; nothing touches a real folder.
test.use({ locale: "en-GB" });

const token = (n) => String(n).repeat(64);
const noGit = { status: "none", worktrees: [], unpushedBranches: null };
const report = (over = {}) => ({
  path: "/work/notes",
  name: "notes",
  folderState: "present",
  token: token(1),
  ready: true,
  refused: null,
  blockers: { sessions: [], runs: [], queue: [], rebuilds: [] },
  processes: { status: "ok", list: [] },
  git: [],
  projects: [{ name: "notes", path: "/work/notes", main: true }],
  access: { agents: [], users: [] },
  ...over,
});
const row = (id, name, extra = {}) => ({
  id,
  name,
  cwd: `/work/${name}`,
  kind: "directory",
  entryCount: 0,
  ...extra,
});

// The hub with a scripted /api/project-deletion: `answers.reports` are the answers to
// successive GETs (the last one repeats), `answers.post` the answer to the POSTs.
async function deletionFixture(page, { projects, deletions = [], ...answers } = {}) {
  const log = { gets: 0, posts: [] };
  const reports = answers.reports ?? [report()];
  const calls = await hubFixture(page, {
    async intercept(route, url, method) {
      if (url.pathname === "/api/memory/projects" && method === "GET") {
        await route.fulfill({
          json: {
            projects: projects ?? [
              row("m1", "agent-pier", { cwd: "/work/agent-pier", entryCount: 4 }),
              row("m2", "notes"),
            ],
            deletions,
          },
        });
        return true;
      }
      if (!url.pathname.startsWith("/api/project-deletion")) return false;
      if (method === "GET") {
        const next = reports[Math.min(log.gets, reports.length - 1)];
        log.gets += 1;
        await route.fulfill({ json: next });
        return true;
      }
      log.posts.push({ path: url.pathname, body: route.request().postDataJSON() });
      const reply = answers.post?.(url.pathname, log.posts.length) ?? {
        status: 202,
        json: url.pathname.endsWith("/blockers") ? reports[reports.length - 1] : {},
      };
      await route.fulfill(reply);
      return true;
    },
  });
  return { calls, log };
}

const dialog = (page) => page.getByRole("dialog");
async function openMenu(page, name, item) {
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("a project is deleted only after its name is typed", async ({ page }) => {
  const git = {
    path: "/work/notes",
    report: {
      status: "ok",
      unpushedBranches: 2,
      worktreesChecked: true,
      worktrees: [{ path: "/work/notes", branch: "main", inside: true, changes: 3 }],
    },
  };
  const { log } = await deletionFixture(page, { reports: [report({ git: [git] })] });
  await page.goto(base + "/projects");
  await page.getByRole("button", { name: /^notes/ }).click();
  await page.getByRole("button", { name: "Actions for notes" }).click();
  await expect(page.getByRole("menuitem", { name: "Delete project …" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Delete project …" }).click();

  const box = dialog(page);
  await expect(
    box.getByRole("heading", { name: "Delete project “notes”?" }),
  ).toBeVisible();
  await expect(box).toContainText("/work/notes");
  await expect(box).toContainText("This cannot be undone.");
  await expect(box).toContainText("Unsaved work is lost");
  await expect(box).toContainText("3 uncommitted changes");
  await expect(box).toContainText("2 commits that no remote has");
  const confirm = box.getByRole("button", { name: "Delete permanently" });
  await expect(confirm).toBeDisabled();
  const name = box.getByRole("textbox");
  await name.fill("note");
  await expect(confirm).toBeDisabled();
  await name.fill("notes");
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(box).toHaveCount(0);
  expect(log.posts).toEqual([
    {
      path: "/api/project-deletion",
      body: { path: "/work/notes", token: token(1), name: "notes" },
    },
  ]);
});

test("running sessions block until Stop sessions", async ({ page }) => {
  const blocked = report({
    ready: false,
    token: token(2),
    blockers: { sessions: [{ id: "s1", name: "Hub fixture session" }], runs: [] },
  });
  const { log } = await deletionFixture(page, { reports: [blocked, report()] });
  await page.goto(base + "/projects");
  await openMenu(page, "notes", "Delete project …");

  const box = dialog(page);
  await expect(box).toContainText("Still running in this project");
  await expect(box).toContainText("Hub fixture session");
  await box.getByRole("textbox").fill("notes");
  await expect(box.getByRole("button", { name: "Delete permanently" })).toBeDisabled();
  await box.getByRole("button", { name: "Stop sessions" }).click();

  await expect(box.getByText("Still running in this project")).toHaveCount(0);
  await expect(box.getByRole("button", { name: "Delete permanently" })).toBeEnabled();
  expect(log.posts).toEqual([
    {
      path: "/api/project-deletion/blockers",
      body: { path: "/work/notes", token: token(2), sessions: true },
    },
  ]);
});

test("only ticked processes are ended; another user's process has no box", async ({
  page,
}) => {
  const busy = report({
    ready: false,
    token: token(3),
    processes: {
      status: "ok",
      list: [
        { pid: 4101, startTime: "t-1", name: "vim", owner: "self", endable: true },
        { pid: 4102, startTime: "t-2", name: "tail", owner: "self", endable: true },
        { pid: 4103, startTime: "t-3", name: "backup", owner: "other", endable: false },
      ],
    },
  });
  const { log } = await deletionFixture(page, { reports: [busy, report()] });
  await page.goto(base + "/projects");
  await openMenu(page, "notes", "Delete project …");

  const box = dialog(page);
  await expect(box.getByRole("checkbox")).toHaveCount(2);
  await expect(box).toContainText("backup (PID 4103)");
  await expect(box).toContainText("Process of another system user");
  const end = box.getByRole("button", { name: "End selected" });
  await expect(end).toBeDisabled();
  await box.getByRole("checkbox", { name: "tail (PID 4102)" }).check();
  await expect(end).toBeEnabled();
  await end.click();

  await expect(box.getByRole("checkbox")).toHaveCount(0);
  expect(log.posts).toEqual([
    {
      path: "/api/project-deletion/blockers",
      body: {
        path: "/work/notes",
        token: token(3),
        processes: [{ pid: 4102, startTime: "t-2" }],
      },
    },
  ]);
});

const missingRows = [
  row("m1", "agent-pier", { cwd: "/work/agent-pier", entryCount: 4 }),
  row("m2", "notes", { folder: "missing" }),
];

test("a missing folder is removed from AgentPier with a plain confirm", async ({
  page,
}) => {
  const gone = report({ folderState: "missing", token: token(4) });
  const { log } = await deletionFixture(page, { projects: missingRows, reports: [gone] });
  await page.goto(base + "/projects");
  await expect(page.getByText("Folder missing").first()).toBeVisible();
  await openMenu(page, "notes", "Remove from AgentPier …");

  const box = dialog(page);
  await expect(
    box.getByRole("heading", { name: "Remove project “notes” from AgentPier?" }),
  ).toBeVisible();
  await expect(box.getByRole("textbox")).toHaveCount(0);
  await box.getByRole("button", { name: "Remove from AgentPier" }).click();
  await expect(box).toHaveCount(0);
  expect(log.posts).toEqual([
    {
      path: "/api/project-deletion",
      body: { path: "/work/notes", token: token(4) },
    },
  ]);
});

test("the Folder missing filter shows the stale projects", async ({ page }) => {
  await deletionFixture(page, { projects: missingRows });
  await page.goto(base + "/projects");
  const list = page.locator(".project-row");
  await expect(list).toHaveCount(2);
  await page.getByRole("radio", { name: "Folder missing (1)" }).click();
  await expect(list).toHaveCount(1);
  await expect(list.first()).toContainText("notes");
  await page.getByRole("radio", { name: "All" }).click();
  await expect(list).toHaveCount(2);
});

test("a failed deletion shows Retry", async ({ page }) => {
  const { log } = await deletionFixture(page, {
    deletions: [{ path: "/work/notes", state: "failed", error: "EACCES" }],
  });
  await page.goto(base + "/projects");
  await expect(page.getByText("Deletion failed — Retry").first()).toBeVisible();
  await page.getByRole("button", { name: /^notes/ }).click();
  await expect(page.getByText("AgentPier may not delete some files")).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => log.posts.length).toBe(1);
  expect(log.posts[0]).toEqual({
    path: "/api/project-deletion/retry",
    body: { path: "/work/notes" },
  });
});

test("an aborted start tells that the agents' access was removed", async ({ page }) => {
  const message =
    "Something still runs in this project or uses its folder, so nothing was deleted. Agents' access to this project was already removed; grant it again if you keep the project.";
  await deletionFixture(page, {
    post: () => ({
      status: 409,
      json: { code: "PROJECT_DELETE_BLOCKED", grantsRevoked: true, error: message },
    }),
  });
  await page.goto(base + "/projects");
  await openMenu(page, "notes", "Delete project …");
  const box = dialog(page);
  await box.getByRole("textbox").fill("notes");
  await box.getByRole("button", { name: "Delete permanently" }).click();
  await expect(box.getByRole("alert")).toContainText("Agents' access to this project");
  await expect(box).toBeVisible();
});

test("a linked worktree that could not be checked is named", async ({ page }) => {
  const git = {
    path: "/work/notes",
    report: {
      status: "ok",
      unpushedBranches: 0,
      worktreesChecked: true,
      worktrees: [
        {
          path: "/elsewhere/notes-feature",
          branch: "feature",
          inside: false,
          checked: false,
        },
      ],
    },
  };
  await deletionFixture(page, { reports: [report({ git: [git] })] });
  await page.goto(base + "/projects");
  await openMenu(page, "notes", "Delete project …");
  const box = dialog(page);
  await expect(box).toContainText("/elsewhere/notes-feature could not be checked.");
  await expect(box).toContainText(
    "The linked worktree /elsewhere/notes-feature lies outside the folder and is kept",
  );
});

test("⌘K Delete project opens the dialog for the open project", async ({ page }) => {
  await deletionFixture(page);
  await page.goto(base + "/projects");
  await page.getByRole("button", { name: /^notes/ }).click();
  await page
    .getByRole("button", { name: /^Search/ })
    .first()
    .click();
  const search = page.getByRole("dialog", { name: "Search" });
  await search.getByRole("combobox").fill("Delete project");
  await search
    .getByRole("option", { name: /Delete project/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Delete project “notes”?" }),
  ).toBeVisible();
});
