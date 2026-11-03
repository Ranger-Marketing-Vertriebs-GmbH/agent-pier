import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

const connectedView = {
  project: { id: "m1", path: "/work/agent-pier" },
  sources: {
    github: {
      state: "connected",
      repo: "acme/app",
      host: "https://github.com",
      credential: { id: "c1", name: "Arbeit" },
      inProgressLabel: "in progress",
    },
    plane: {
      state: "connected",
      connectionId: "pc1",
      connectionName: "Plane Arbeit",
      planeProjectId: "11111111-1111-4111-8111-111111111111",
      identifier: "AP",
      name: "App",
      inProgressStateId: null,
    },
  },
  starts: [
    {
      id: "st1",
      projectId: "m1",
      source: "github",
      key: "acme/app#9",
      title: "Started issue",
      kind: "session",
      targetId: "s1",
      startedAt: 1000,
      writeBack: { state: "done" },
    },
    {
      id: "st2",
      projectId: "m1",
      source: "plane",
      key: "AP-4",
      title: "Refused item",
      kind: "pipeline",
      targetId: "r9",
      startedAt: 2000,
      writeBack: { state: "failed", code: "forbidden" },
    },
  ],
};

const ticket = (source, key, title, labels) => ({
  source,
  key,
  number: Number(key.split(/[#-]/).at(-1)),
  id: key,
  title,
  body: "",
  url:
    source === "github"
      ? `https://github.com/acme/app/issues/${key.split("#")[1]}`
      : `https://plane.example/AP/${key}`,
  labels,
  state: "open",
  updatedAt: "2026-11-03T10:00:00Z",
});

const ticketList = {
  tickets: [
    ticket("github", "acme/app#7", "Fix the login", ["ui"]),
    ticket("plane", "AP-3", "Add export", ["feature"]),
    ticket("github", "acme/app#9", "Started issue", ["bug"]),
    ticket("plane", "AP-4", "Refused item", ["bug"]),
  ],
  labels: ["bug", "feature", "ui"],
  errors: [],
};

// Answers the ticket routes of project m1; `start` answers each POST …/start.
async function ticketsFixture(page, { view = connectedView, list = ticketList, start }) {
  const posts = [];
  const calls = await hubFixture(page, {
    intercept: async (route, url, method) => {
      // The launch dialog's own reads.
      if (url.pathname === "/api/ssh-accesses") {
        await route.fulfill({ json: { accesses: [] } });
        return true;
      }
      if (url.pathname === "/api/tickets/projects/m1") {
        await route.fulfill({ json: view });
        return true;
      }
      if (url.pathname === "/api/tickets/projects/m1/tickets") {
        await route.fulfill({ json: list });
        return true;
      }
      if (url.pathname === "/api/tickets/projects/m1/start" && method === "POST") {
        const body = route.request().postDataJSON();
        posts.push(body);
        const answer = start?.(body, posts.length) ?? {
          status: 201,
          json: { start: { id: "new" }, run: { id: "new-run" } },
        };
        await route.fulfill(answer);
        return true;
      }
      return false;
    },
  });
  return { posts, calls };
}

const menuOf = (page, key) =>
  page.getByRole("button", { name: `Aktionen für ${key}`, exact: true });

test("the Tickets tab lists, filters and starts a ticket as a pipeline run", async ({
  page,
}) => {
  const { posts, calls } = await ticketsFixture(page, {});
  await page.goto(base + "/projects/m1?tab=tickets");
  await expect(page.getByRole("tab", { name: "Tickets" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("acme/app#7 Fix the login")).toBeVisible();
  await expect(page.getByText("AP-3 Add export")).toBeVisible();
  await expect(page.getByText("AP · App · Plane Arbeit")).toBeVisible();
  // A started ticket shows its chip; a refused write-back shows on the row.
  await expect(page.getByText("Gestartet", { exact: true })).toBeVisible();
  await expect(page.getByText("Zurückschreiben fehlgeschlagen")).toBeVisible();
  await expect(
    page.getByText(/nicht als in Arbeit markiert: Der API-Schlüssel hat dafür keine/),
  ).toBeVisible();

  // The label filter keeps its value in the address.
  await page.getByRole("button", { name: "Label", exact: true }).click();
  await page.getByRole("option", { name: "bug", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=tickets&label=bug$/);
  await expect(page.getByText("AP-3 Add export")).toHaveCount(0);
  await expect(page.getByText("AP-4 Refused item")).toBeVisible();

  // The source segment narrows to one source.
  await page.getByRole("radio", { name: "GitHub" }).check();
  await expect(page.getByText("AP-4 Refused item")).toHaveCount(0);
  await page.getByRole("radio", { name: "Alle" }).check();

  // Refresh reads the list again; no timer does.
  const reads = () =>
    calls.filter((call) => call.path === "/api/tickets/projects/m1/tickets" && !call.stub)
      .length;
  const before = reads();
  await page.getByRole("button", { name: "Aktualisieren" }).click();
  await expect.poll(reads).toBe(before + 1);

  // A started ticket asks before it starts again.
  await menuOf(page, "acme/app#9").click();
  await page.getByRole("menuitem", { name: "Pipeline-Lauf starten" }).click();
  const confirm = page.getByRole("dialog", { name: "acme/app#9 erneut starten?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Erneut starten" }).click();
  const dialog = page.getByRole("dialog", {
    name: "acme/app#9 als Pipeline-Lauf starten",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Aufgabe")).toHaveCount(0);
  await expect(dialog.getByLabel("Repository-Ordner")).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Entwicklungsablauf", exact: true }).check();
  await dialog.getByRole("button", { name: "Erneut starten" }).click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/new-run$/);
  expect(posts).toEqual([
    {
      source: "github",
      key: "acme/app#9",
      kind: "pipeline",
      again: true,
      pipeline: { pipelineId: "p1" },
    },
  ]);
});

test("a double start shows the refusal and offers to start again", async ({ page }) => {
  const { posts } = await ticketsFixture(page, {
    start: (_body, count) =>
      count === 1
        ? {
            status: 409,
            json: {
              error:
                "Dieses Ticket wurde schon gestartet. Bestätige, um es erneut zu starten.",
              messageKey: "tickets.alreadyStarted",
            },
          }
        : undefined,
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await menuOf(page, "acme/app#7").click();
  await page.getByRole("menuitem", { name: "Pipeline-Lauf starten" }).click();
  const dialog = page.getByRole("dialog", {
    name: "acme/app#7 als Pipeline-Lauf starten",
  });
  await dialog.getByRole("radio", { name: "Entwicklungsablauf", exact: true }).check();
  await dialog.getByRole("button", { name: "Lauf starten" }).click();
  await expect(dialog.getByText(/wurde schon gestartet/)).toBeVisible();
  await dialog.getByRole("button", { name: "Erneut starten" }).click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/new-run$/);
  expect(posts.map((body) => body.again)).toEqual([false, true]);
});

test("in English the tab, menu and errors read in English", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const { posts } = await ticketsFixture(page, {
    start: () => ({
      status: 201,
      json: {
        start: { id: "new" },
        session: { id: "s1", name: "Hub fixture session", tool: "codex" },
      },
    }),
    list: {
      ...ticketList,
      tickets: ticketList.tickets.filter((item) => item.source === "github"),
      errors: [{ source: "plane", code: "forbidden" }],
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await expect(page.getByRole("tab", { name: "Tickets" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByText("Plane: The API key has no permission for this."),
  ).toBeVisible();
  await expect(page.getByText("Started", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Ticket sources" })).toBeVisible();
  await page.getByRole("button", { name: "Actions for acme/app#7", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Start session" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Start pipeline run" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Open in GitHub" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Start session" }).click();
  const dialog = page.getByRole("dialog", { name: "Start acme/app#7 as a session" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Working directory")).toHaveCount(0);
  await expect(dialog.getByText("Task profile")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toHaveLength(1);
  const [body] = posts;
  expect(body).toMatchObject({
    source: "github",
    key: "acme/app#7",
    kind: "session",
    again: false,
  });
  // The server picks the folder and the name; the browser sends neither.
  expect(body.session.cwd).toBeUndefined();
  expect(body.session.name).toBeUndefined();
  expect(body.session.accountId).toBe("local-codex");
});

test("without sources the tab links to Connections", async ({ page }) => {
  await ticketsFixture(page, {
    view: {
      ...connectedView,
      sources: {
        github: { state: "notConnected", inProgressLabel: "in progress" },
        plane: { state: "notConnected" },
      },
      starts: [],
    },
  });
  await page.goto(base + "/projects/m1?tab=tickets");
  await expect(page.getByText("Keine Ticketquelle verbunden")).toBeVisible();
  await expect(page.getByRole("button", { name: "Label", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: /GitHub-Zugänge/ }).click();
  await expect(page).toHaveURL(/\/connections\?section=github$/);
});
