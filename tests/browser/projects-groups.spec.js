import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture, repositoryPath } from "./projects-fixture.js";

// The projects list with project groups (search, views, groups, ⋯ menu), in English.
test.use({ locale: "en-GB" });

const owners = ["acme", "beta-org", ""];
const manyProjects = Array.from({ length: 30 }, (_, index) => ({
  id: `m${index + 10}`,
  name: `proj-${String(index).padStart(2, "0")}`,
  cwd: `/work/proj-${index}`,
  kind: "directory",
  entryCount: 0,
  remote: owners[index % 3]
    ? `https://github.com/${owners[index % 3]}/proj-${index}.git`
    : "",
}));

// A project-groups server in memory: version check, ids for new groups, 409 with the
// current document. `fail` answers the next PUT with a 400.
async function groupsFixture(page, { projects, ...controls } = {}) {
  const server = { document: { version: 0, groups: [], assignments: {} }, puts: [] };
  let nextId = 1;
  const calls = await hubFixture(page, {
    ...controls,
    async intercept(route, url, method) {
      if (projects && url.pathname === "/api/memory/projects" && method === "GET") {
        await route.fulfill({ json: { projects } });
        return true;
      }
      if (url.pathname !== "/api/project-groups") return false;
      if (method === "GET") {
        await route.fulfill({ json: server.document });
        return true;
      }
      const body = route.request().postDataJSON();
      server.puts.push(body);
      if (server.fail) {
        server.fail = false;
        await route.fulfill({
          status: 400,
          json: { code: "PROJECT_GROUP_INVALID", error: "Refused by the server." },
        });
      } else if (body.version !== server.document.version)
        await route.fulfill({
          status: 409,
          json: {
            ...server.document,
            code: "PROJECT_GROUP_CONFLICT",
            error: "The groups were changed elsewhere in the meantime.",
          },
        });
      else {
        server.document = {
          version: server.document.version + 1,
          groups: body.groups.map((group) =>
            group.id ? group : { id: `g_${nextId++}`, name: group.name },
          ),
          assignments: body.assignments,
        };
        await route.fulfill({ json: server.document });
      }
      return true;
    },
  });
  return { server, calls };
}

const projectList = (page) =>
  page.getByRole("navigation", { name: "Projects", exact: true });
const section = (page, name) =>
  projectList(page).getByRole("button", { name: new RegExp(`^${name}\\s*\\d+$`) });
const rowNames = (page) =>
  projectList(page).locator(".project-row strong").filter({ visible: true });

test("the list scrolls in its own container while the detail header stays put", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await groupsFixture(page, { projects: manyProjects });
  await page.goto(base + "/projects");
  const header = page.locator(".project-card-header");
  const tabs = page.getByRole("tablist");
  await expect(page.getByRole("heading", { name: "agent-pier", level: 2 })).toBeVisible();
  const before = [await header.boundingBox(), await tabs.boundingBox()];
  const scroller = projectList(page).locator(".project-list-scroller");
  const scrolled = await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    return node.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  await expect(page.getByText("proj-29", { exact: true })).toBeInViewport();
  expect([await header.boundingBox(), await tabs.boundingBox()]).toEqual(before);
  // The page body itself never scrolls; the section header sticks to the list top.
  expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
  const top = (await scroller.boundingBox()).y;
  const sticky = await section(page, "No group").boundingBox();
  expect(Math.abs(sticky.y - top)).toBeLessThanOrEqual(12);
});

test("search filters every view and names a query without matches", async ({ page }) => {
  await groupsFixture(page);
  await page.goto(base + "/projects");
  const search = page.getByRole("searchbox", { name: "Search projects" });
  await expect(search).toHaveAttribute("placeholder", "Search projects …");
  await expect(rowNames(page)).toHaveText(["agent-pier", "notes"]);
  await search.fill("ACME/");
  await expect(rowNames(page)).toHaveText(["agent-pier"]);
  await search.fill("zzz");
  await expect(rowNames(page)).toHaveCount(0);
  await expect(projectList(page)).toContainText("No project matches “zzz”.");
  await search.fill("");
  await expect(rowNames(page)).toHaveText(["agent-pier", "notes"]);
  const agentPier = projectList(page).getByRole("button", { name: /^agent-pier/ });
  await expect(agentPier).toContainText("Running");
  await expect(
    projectList(page).getByRole("button", { name: /^notes/ }),
  ).not.toContainText("Running");
});

test("the view switch shows origins or a flat list and is remembered", async ({
  page,
}) => {
  await groupsFixture(page);
  await page.goto(base + "/projects");
  const views = page.getByRole("radiogroup", { name: "View" });
  await expect(views.getByRole("radio", { name: "Groups" })).toBeChecked();
  await expect(section(page, "No group")).toBeVisible();
  await expect(page.getByRole("button", { name: "New group" })).toBeVisible();

  await views.getByRole("radio", { name: "Origin" }).check();
  await expect(section(page, "acme")).toBeVisible();
  await expect(section(page, "Local only")).toBeVisible();
  await expect(page.getByRole("button", { name: "New group" })).toHaveCount(0);
  // Collapsing a section is remembered per view.
  await section(page, "acme").click();
  await expect(section(page, "acme")).toHaveAttribute("aria-expanded", "false");
  await expect(rowNames(page)).toHaveText(["notes"]);

  await page.reload();
  await expect(views.getByRole("radio", { name: "Origin" })).toBeChecked();
  await expect(section(page, "acme")).toHaveAttribute("aria-expanded", "false");
  // A search opens every section.
  await page.getByRole("searchbox", { name: "Search projects" }).fill("agent");
  await expect(rowNames(page)).toHaveText(["agent-pier"]);
  await page.getByRole("searchbox", { name: "Search projects" }).fill("");

  await views.getByRole("radio", { name: "List" }).check();
  await expect(projectList(page).locator(".project-section-toggle")).toHaveCount(0);
  await expect(rowNames(page)).toHaveText(["agent-pier", "notes"]);
});

test("a group is created inline, a project moves into it via ⋯ and out again", async ({
  page,
}) => {
  const { server } = await groupsFixture(page);
  await page.goto(base + "/projects");
  await page.getByRole("button", { name: "New group" }).click();
  const name = page.getByRole("textbox", { name: "Group name" });
  await expect(name).toBeFocused();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a name for the group.");
  await name.press("Escape");
  await expect(name).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New group" })).toBeFocused();

  await page.getByRole("button", { name: "New group" }).click();
  await name.fill("Clients");
  await name.press("Enter");
  await expect(name).toHaveCount(0);
  await expect(section(page, "Clients")).toBeVisible();
  await expect(projectList(page)).toContainText("Empty – move projects here with ⋯.");
  expect(server.puts).toEqual([
    { version: 0, groups: [{ name: "Clients" }], assignments: {} },
  ]);

  await page.getByRole("button", { name: "New group" }).click();
  await name.fill(" clients ");
  await name.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "A group with this name already exists.",
  );
  await page.getByRole("button", { name: "Cancel" }).click();

  // Move agent-pier into Clients from its ⋯ menu.
  await page.getByRole("button", { name: "Actions for agent-pier" }).click();
  const menu = page.getByRole("menu", { name: "Actions for agent-pier" });
  await expect(menu.getByRole("group", { name: "Move to group" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Remove from group" })).toHaveCount(0);
  await menu.getByRole("menuitemradio", { name: "Clients" }).click();
  await expect(menu).toHaveCount(0);
  const clients = projectList(page).locator('[data-section="group:g_1"]');
  await expect(section(page, "Clients")).toHaveText(/Clients\s*1/);
  await expect(clients.locator(".project-row strong")).toHaveText(["agent-pier"]);
  expect(server.puts.at(-1)).toEqual({
    version: 1,
    groups: [{ id: "g_1", name: "Clients" }],
    assignments: { [repositoryPath]: "g_1" },
  });
  const groupFact = page.getByRole("definition").last();
  await expect(groupFact).toHaveText("Clients");

  await page.getByRole("button", { name: "Actions for agent-pier" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Clients" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await menu.getByRole("menuitem", { name: "Remove from group" }).click();
  await expect(section(page, "Clients")).toHaveText(/Clients\s*0/);
  await expect(groupFact).toHaveText("No group");
  expect(server.puts.at(-1).assignments).toEqual({});

  // "New group …" creates the group, then moves the project into it.
  await page.getByRole("button", { name: "Actions for notes" }).click();
  await page
    .getByRole("menu", { name: "Actions for notes" })
    .getByRole("menuitem", { name: "New group …" })
    .click();
  await expect(name).toBeFocused();
  await name.fill("Archive");
  await name.press("Enter");
  await expect(section(page, "Archive")).toHaveText(/Archive\s*1/);
  expect(server.puts.slice(-2)).toEqual([
    {
      version: 3,
      groups: [{ id: "g_1", name: "Clients" }, { name: "Archive" }],
      assignments: {},
    },
    {
      version: 4,
      groups: [
        { id: "g_1", name: "Clients" },
        { id: "g_2", name: "Archive" },
      ],
      assignments: { "/work/notes": "g_2" },
    },
  ]);
});

test("a refused move rolls back, a conflict adopts the server's groups", async ({
  page,
}) => {
  const { server } = await groupsFixture(page);
  server.document = {
    version: 2,
    groups: [{ id: "g_1", name: "Clients" }],
    assignments: {},
  };
  await page.goto(base + "/projects");
  await expect(section(page, "Clients")).toBeVisible();

  server.fail = true;
  await page.getByRole("button", { name: "Actions for notes" }).click();
  await page.getByRole("menuitemradio", { name: "Clients" }).click();
  await expect(page.getByRole("alert")).toHaveText("Refused by the server.");
  await expect(section(page, "Clients")).toHaveText(/Clients\s*0/);

  // Another device renamed the group meanwhile: the move is dropped, the new name shows.
  server.document = {
    version: 3,
    groups: [{ id: "g_1", name: "Customers" }],
    assignments: {},
  };
  await page.getByRole("button", { name: "Actions for notes" }).click();
  await page.getByRole("menuitemradio", { name: "Clients" }).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  await expect(section(page, "Customers")).toHaveText(/Customers\s*0/);
  expect(server.puts.at(-1).version).toBe(2);
  expect(server.puts).toHaveLength(2);
});
