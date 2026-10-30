import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { groupsFixture, projectList, section } from "./projects-groups-fixture.js";
import { repositoryPath } from "./projects-fixture.js";

// Drag and drop on the desktop projects list (mouse, fine pointer), in English.
test.use({ locale: "en-GB" });

const seeded = (server) => {
  server.document = {
    version: 3,
    groups: [
      { id: "g_1", name: "Clients" },
      { id: "g_2", name: "Games" },
      { id: "g_3", name: "Empty" },
    ],
    assignments: { "/work/notes": "g_1" },
  };
};
const row = (page, name) =>
  projectList(page)
    .locator(".project-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .locator(".project-row-main");
const area = (page, key) => projectList(page).locator(`[data-section="${key}"]`);
const headers = (page) => projectList(page).locator(".project-section-title");
const center = async (locator, dy = 0) => {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 + dy };
};

// Presses on `from`, moves past the threshold, then to `to` (a locator or a point).
async function dragTo(page, from, to, { release = true } = {}) {
  const start = await center(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 6, { steps: 2 });
  const end = typeof to.x === "number" ? to : await center(to);
  await page.mouse.move(end.x, end.y, { steps: 8 });
  if (release) await page.mouse.up();
}

async function open(page, server) {
  seeded(server);
  await page.goto(base + "/projects");
  await expect(headers(page)).toHaveText(["Clients", "Games", "Empty", "No group"]);
}

test("a project dragged onto a group, its empty hint or No group moves there", async ({
  page,
}) => {
  const { server } = await groupsFixture(page);
  await open(page, server);
  const status = projectList(page).getByRole("status");

  // Onto a group header: highlighted while over it, then saved and announced.
  await dragTo(page, row(page, "notes"), section(page, "Games"), { release: false });
  await expect(area(page, "group:g_2")).toHaveClass(/drop-target/);
  await expect(projectList(page).locator(".project-row.dragging")).toHaveCount(1);
  await page.mouse.up();
  await expect(area(page, "group:g_2").getByText("notes", { exact: true })).toBeVisible();
  expect(server.puts.at(-1)).toEqual({
    version: 3,
    groups: server.document.groups,
    assignments: { "/work/notes": "g_2" },
  });
  await expect(status).toHaveText("notes → Games");
  await expect(projectList(page).locator(".drop-target, .dragging")).toHaveCount(0);

  // Onto an empty group's dashed hint.
  await dragTo(
    page,
    row(page, "agent-pier"),
    area(page, "group:g_3").getByText(/^Empty – move projects/),
  );
  await expect(
    area(page, "group:g_3").getByText("agent-pier", { exact: true }),
  ).toBeVisible();
  expect(server.puts.at(-1).assignments).toEqual({
    "/work/notes": "g_2",
    [repositoryPath]: "g_3",
  });
  await expect(status).toHaveText("agent-pier → Empty");

  // Every project is grouped now: "No group" still shows up as a target while dragging.
  await expect(section(page, "No group")).toHaveCount(0);
  await dragTo(page, row(page, "notes"), area(page, "group:g_1"), { release: false });
  await expect(section(page, "No group")).toBeVisible();
  const noGroup = await center(section(page, "No group"));
  await page.mouse.move(noGroup.x, noGroup.y, { steps: 4 });
  await expect(area(page, "ungrouped")).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect(area(page, "ungrouped").getByText("notes", { exact: true })).toBeVisible();
  expect(server.puts.at(-1).assignments).toEqual({ [repositoryPath]: "g_3" });
  await expect(status).toHaveText("notes → No group");

  // Dropping on its own group does nothing.
  let puts = server.puts.length;
  await dragTo(page, row(page, "notes"), section(page, "No group"));
  await expect(projectList(page).locator(".dragging")).toHaveCount(0);
  expect(server.puts).toHaveLength(puts);

  // A refused drop is rolled back and not announced.
  server.fail = true;
  await dragTo(page, row(page, "notes"), section(page, "Games"));
  await expect(page.getByRole("alert")).toHaveText("Refused by the server.");
  await expect(area(page, "ungrouped").getByText("notes", { exact: true })).toBeVisible();
  await expect(status).toHaveText("notes → No group");

  // The same message again (after a menu move in between) is a new announcement.
  await dragTo(page, row(page, "notes"), section(page, "Games"));
  await expect(status).toHaveText("notes → Games");
  const first = await status.textContent();
  await page.getByRole("button", { name: "Actions for notes" }).click();
  await page.getByRole("menuitem", { name: "Remove from group" }).click();
  await expect(area(page, "ungrouped").getByText("notes", { exact: true })).toBeVisible();
  puts = server.puts.length;
  await dragTo(page, row(page, "notes"), section(page, "Games"));
  // Announced again once saved: the text is the same, the region's content is new.
  await expect.poll(() => status.textContent()).not.toBe(first);
  expect(server.puts).toHaveLength(puts + 1);
  await expect(status).toHaveText("notes → Games");
});

test("a group header dragged between groups moves there; No group stays last", async ({
  page,
}) => {
  const { server } = await groupsFixture(page);
  await open(page, server);

  await dragTo(page, section(page, "Empty"), section(page, "Clients"), {
    release: false,
  });
  await expect(area(page, "group:g_1")).toHaveClass(/insert-before/);
  await expect(area(page, "group:g_3")).toHaveClass(/dragging/);
  await page.mouse.up();
  await expect(headers(page)).toHaveText(["Empty", "Clients", "Games", "No group"]);
  expect(server.puts.at(-1).groups.map((group) => group.id)).toEqual([
    "g_3",
    "g_1",
    "g_2",
  ]);
  await expect(projectList(page).getByRole("status")).toHaveText(
    "Empty moved to position 1",
  );
  // The click that ended the drag did not collapse the header.
  await expect(section(page, "Empty")).toHaveAttribute("aria-expanded", "true");

  // Over "No group" a group goes last among the groups, never after "No group".
  await dragTo(page, section(page, "Empty"), section(page, "No group"), {
    release: false,
  });
  await expect(area(page, "group:g_2")).toHaveClass(/insert-after/);
  await page.mouse.up();
  await expect(headers(page)).toHaveText(["Clients", "Games", "Empty", "No group"]);
  expect(server.puts.at(-1).groups.map((group) => group.id)).toEqual([
    "g_1",
    "g_2",
    "g_3",
  ]);
  await expect(projectList(page).getByRole("status")).toHaveText(
    "Empty moved to position 3",
  );

  // "No group" is not draggable, and a group dropped on its own place saves nothing.
  const puts = server.puts.length;
  await dragTo(page, section(page, "No group"), section(page, "Clients"));
  await dragTo(page, section(page, "Games"), section(page, "Games"));
  await expect(headers(page)).toHaveText(["Clients", "Games", "Empty", "No group"]);
  expect(server.puts).toHaveLength(puts);
});

test("Escape cancels a drag, a drop outside does nothing, a click still selects", async ({
  page,
}) => {
  const { server } = await groupsFixture(page);
  await open(page, server);
  const heading = (name) => page.getByRole("heading", { name, level: 2 });
  await expect(heading("agent-pier")).toBeVisible();

  await dragTo(page, row(page, "notes"), section(page, "Games"), { release: false });
  await expect(area(page, "group:g_2")).toHaveClass(/drop-target/);
  await page.keyboard.press("Escape");
  await expect(projectList(page).locator(".drop-target, .dragging")).toHaveCount(0);
  await page.mouse.up();
  // Neither saved nor selected by the release.
  await expect(area(page, "group:g_1").getByText("notes", { exact: true })).toBeVisible();
  await expect(heading("agent-pier")).toBeVisible();
  expect(server.puts).toHaveLength(0);

  // Released outside the list (over the detail): nothing happens.
  await dragTo(page, row(page, "notes"), page.locator(".project-card-header"));
  await expect(projectList(page).locator(".dragging")).toHaveCount(0);
  expect(server.puts).toHaveLength(0);
  await expect(heading("agent-pier")).toBeVisible();

  // A click with less than 4px of movement selects the project as before.
  const start = await center(row(page, "notes"));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 2, start.y + 1);
  await page.mouse.up();
  await expect(heading("notes")).toBeVisible();
  await expect(row(page, "notes")).toHaveAttribute("aria-current", "true");
  // The header still collapses on click, and ⋯ still opens its menu.
  await section(page, "Games").click();
  await expect(section(page, "Games")).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Actions for notes" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  expect(server.puts).toHaveLength(0);
});

test("a collapsed group opens when hovered during a drag", async ({ page }) => {
  const { server } = await groupsFixture(page);
  await open(page, server);
  await section(page, "Games").click();
  await expect(section(page, "Games")).toHaveAttribute("aria-expanded", "false");

  await dragTo(page, row(page, "notes"), section(page, "Games"), { release: false });
  await expect(section(page, "Games")).toHaveAttribute("aria-expanded", "true");
  await page.mouse.up();
  await expect(area(page, "group:g_2").getByText("notes", { exact: true })).toBeVisible();
});

test("the list scrolls while a drag nears its bottom or top edge", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const projects = Array.from({ length: 30 }, (_, index) => ({
    id: `m${index + 10}`,
    name: `proj-${String(index).padStart(2, "0")}`,
    cwd: `/work/proj-${index}`,
    kind: "directory",
    entryCount: 0,
  }));
  const { server } = await groupsFixture(page, { projects });
  server.document = {
    version: 1,
    groups: [{ id: "g_1", name: "Top" }],
    assignments: {},
  };
  await page.goto(base + "/projects");
  await expect(section(page, "Top")).toBeVisible();
  const scroller = projectList(page).locator(".project-list-scroller");
  const box = await scroller.boundingBox();
  await dragTo(
    page,
    row(page, "proj-00"),
    { x: box.x + box.width / 2, y: box.y + box.height - 8 },
    { release: false },
  );
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(100);
  // Beside the list nothing scrolls; at its top edge it scrolls back up.
  const scrolled = await scroller.evaluate((node) => node.scrollTop);
  await page.mouse.move(box.x + box.width + 40, box.y + box.height - 8, { steps: 2 });
  await page.waitForTimeout(200);
  const beside = await scroller.evaluate((node) => node.scrollTop);
  expect(beside).toBeGreaterThanOrEqual(scrolled);
  await page.waitForTimeout(200);
  expect(await scroller.evaluate((node) => node.scrollTop)).toBe(beside);
  await page.mouse.move(box.x + box.width / 2, box.y + 8, { steps: 4 });
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollTop))
    .toBeLessThan(beside - 100);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(server.puts).toHaveLength(0);
});

test("no drag in the Origin and List views or while searching", async ({ page }) => {
  const { server } = await groupsFixture(page);
  await open(page, server);
  const view = page.getByRole("radiogroup", { name: "View" });
  const tryDrag = async (target) => {
    await dragTo(page, row(page, "notes"), target, { release: false });
    await expect(projectList(page).locator(".dragging")).toHaveCount(0);
    await page.mouse.up();
  };

  await page.getByRole("searchbox", { name: "Search projects" }).fill("notes");
  await expect(section(page, "Games")).toHaveCount(0);
  await tryDrag(page.getByRole("searchbox", { name: "Search projects" }));
  await page.getByRole("searchbox", { name: "Search projects" }).fill("");

  await view.getByRole("radio", { name: "Origin" }).click();
  await tryDrag(projectList(page).locator(".project-section-toggle").first());
  await view.getByRole("radio", { name: "List" }).click();
  await tryDrag(row(page, "agent-pier"));
  expect(server.puts).toHaveLength(0);
});

test("the phone layout offers no drag, even with a fine pointer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { server } = await groupsFixture(page);
  await open(page, server);
  await dragTo(page, row(page, "notes"), section(page, "Games"), { release: false });
  await expect(projectList(page).locator(".project-row.dragging")).toHaveCount(0);
  await expect(area(page, "group:g_2")).not.toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect(section(page, "Clients")).toHaveText(/Clients\s*1/);
  expect(server.puts).toEqual([]);
});
