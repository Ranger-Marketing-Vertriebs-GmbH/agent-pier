import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import {
  projectList,
  rowNames,
  section,
  groupsFixture,
} from "./projects-groups-fixture.js";
import { repositoryPath } from "./projects-fixture.js";

// The projects page on a phone: fixed tools above a scrolling list, the ⋯ menus as
// sheets, and the detail subpage with chips and the fixed launch bar. In English.
test.use({ locale: "en-GB" });

const phone = { width: 390, height: 844 };
// Seeded ids differ from the fixture's own (`g_1`, …) for groups created here.
const seeded = (server) => {
  server.document = {
    version: 3,
    groups: [
      { id: "seed_1", name: "Clients" },
      { id: "seed_2", name: "Games" },
    ],
    assignments: { [repositoryPath]: "seed_1" },
  };
};
const many = Array.from({ length: 20 }, (_, index) => ({
  id: `m${index + 10}`,
  name: `proj-${String(index).padStart(2, "0")}`,
  cwd: `/work/proj-${index}`,
  kind: "directory",
  entryCount: 0,
}));
const fixtureProjects = [
  {
    id: "m1",
    name: "agent-pier",
    cwd: repositoryPath,
    kind: "repository",
    entryCount: 4,
  },
  { id: "m2", name: "notes", cwd: "/work/notes", kind: "directory", entryCount: 0 },
];
const box = async (locator) => {
  const { x, y, width, height } = await locator.boundingBox();
  return { x: Math.round(x), y: Math.round(y), width, height };
};
const sheetFor = (page, name) => page.getByRole("dialog", { name, exact: true });

test("the list scrolls below fixed tools; rows open the detail and back returns", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  const { server } = await groupsFixture(page, {
    projects: [...fixtureProjects, ...many],
  });
  seeded(server);
  await page.goto(base + "/projects");
  const list = projectList(page);
  await expect(section(page, "Clients")).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search projects" });
  expect(await search.evaluate((node) => getComputedStyle(node).fontSize)).toBe("16px");
  for (const control of [
    page.getByRole("button", { name: "New group" }),
    list.getByRole("button", { name: "Actions for agent-pier" }),
    list.getByRole("button", { name: "Actions for group Clients" }),
  ]) {
    const { width, height } = await control.boundingBox();
    expect(Math.round(width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(height)).toBeGreaterThanOrEqual(44);
  }
  const row = list.locator(".project-row-main").first();
  expect(Math.round((await row.boundingBox()).height)).toBeGreaterThanOrEqual(56);
  // A row carries only its ⋯, no chevron.
  await expect(list.locator(".project-item-chevron")).toHaveCount(0);

  const tools = list.locator(".project-list-tools");
  const before = await box(tools);
  const scroller = list.locator(".project-list-scroller");
  expect(
    await scroller.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return node.scrollTop;
    }),
  ).toBeGreaterThan(0);
  await expect(page.getByText("proj-19", { exact: true })).toBeInViewport();
  expect(await box(tools)).toEqual(before);
  expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);

  await scroller.evaluate((node) => (node.scrollTop = 0));
  await list.getByRole("button", { name: /^agent-pier/ }).click();
  await expect(page).toHaveURL(/\/projects\/m1$/);
  await expect(page.getByRole("heading", { name: "agent-pier", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "All projects" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(rowNames(page).first()).toHaveText("agent-pier");

  // The search survives opening a result and coming back.
  await search.fill("notes");
  await expect(rowNames(page)).toHaveText(["notes"]);
  await list.getByRole("button", { name: /^notes/ }).click();
  await expect(page).toHaveURL(/\/projects\/m2$/);
  await page.getByRole("button", { name: "All projects" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(search).toHaveValue("notes");
  await expect(rowNames(page)).toHaveText(["notes"]);
});

test("the project sheet moves, removes and creates a group", async ({ page }) => {
  await page.setViewportSize(phone);
  const { server } = await groupsFixture(page);
  seeded(server);
  await page.goto(base + "/projects");
  const more = page.getByRole("button", { name: "Actions for notes" });
  await expect(more).toHaveAttribute("aria-haspopup", "dialog");
  await more.click();
  let sheet = sheetFor(page, "notes");
  await expect(sheet.getByText("Current: No group")).toBeVisible();
  const menu = sheet.getByRole("menu", { name: "Actions for notes" });
  await expect(menu.getByRole("menuitemradio")).toHaveText(["Clients", "Games"]);
  await expect(menu.getByRole("menuitem")).toHaveText(["New group …"]);
  // The sheet spans the phone's width and ends at its bottom edge.
  const { width, y, height } = await sheet.boundingBox();
  expect(Math.round(width)).toBe(390);
  expect(Math.round(y + height)).toBe(844);
  // Cancel closes and returns focus to the ⋯.
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(more).toBeFocused();
  expect(server.puts).toHaveLength(0);

  await more.click();
  await sheet.getByRole("menuitemradio", { name: "Games" }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => server.puts.at(-1)?.assignments["/work/notes"]).toBe("seed_2");
  await expect(section(page, "Games")).toContainText("1");

  await more.click();
  sheet = sheetFor(page, "notes");
  await expect(sheet.getByText("Current: Games")).toBeVisible();
  await expect(sheet.getByRole("menuitemradio", { name: "Games" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await sheet.getByRole("menuitem", { name: "Remove from group" }).click();
  await expect.poll(() => server.puts.at(-1)?.assignments["/work/notes"]).toBeUndefined();

  await more.click();
  await sheetFor(page, "notes").getByRole("menuitem", { name: "New group …" }).click();
  const name = page.getByRole("textbox", { name: "Group name" });
  await name.fill("Phone");
  await name.press("Enter");
  await expect(section(page, "Phone")).toBeVisible();
  await expect
    .poll(() => server.document.assignments["/work/notes"])
    .toBe(server.document.groups.find((group) => group.name === "Phone")?.id);
  // Without an older entry of its folder the sheet offers no merge.
  await more.click();
  await expect(
    sheetFor(page, "notes").getByRole("menuitem", { name: "Merge older entry" }),
  ).toHaveCount(0);
});

test("the group sheet renames, reorders and deletes a group", async ({ page }) => {
  await page.setViewportSize(phone);
  const { server } = await groupsFixture(page);
  seeded(server);
  await page.goto(base + "/projects");
  const actions = (name) =>
    page.getByRole("button", { name: `Actions for group ${name}` });
  await actions("Clients").click();
  let sheet = sheetFor(page, "Clients");
  await expect(sheet.getByRole("menuitem")).toHaveText([
    "Rename",
    "Move down",
    "Delete group",
  ]);
  await sheet.getByRole("menuitem", { name: "Rename" }).click();
  await expect(sheet).toHaveCount(0);
  const name = page.getByRole("textbox", { name: "Group name" });
  await expect(name).toHaveValue("Clients");
  await name.fill("Customers");
  await name.press("Enter");
  await expect(section(page, "Customers")).toBeVisible();
  expect(server.puts.at(-1).groups[0]).toEqual({ id: "seed_1", name: "Customers" });

  await actions("Games").click();
  await sheetFor(page, "Games").getByRole("menuitem", { name: "Move up" }).click();
  await expect
    .poll(() => server.puts.at(-1).groups.map((group) => group.id))
    .toEqual(["seed_2", "seed_1"]);

  await actions("Customers").click();
  sheet = sheetFor(page, "Customers");
  await sheet.getByRole("menuitem", { name: "Delete group" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete group “Customers”?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(section(page, "Customers")).toHaveCount(0);
  await expect(section(page, "No group")).toContainText("2");
  expect(server.puts.at(-1).groups).toEqual([{ id: "seed_2", name: "Games" }]);
});

test("the detail shows chips, opens the same sheet and keeps its launch bar fixed", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  const { server } = await groupsFixture(page);
  seeded(server);
  await page.goto(base + "/projects/m1");
  const header = page.locator(".settings-shell-header");
  await expect(header.getByRole("heading", { name: "agent-pier", level: 1 })).toHaveCSS(
    "font-size",
    "22px",
  );
  await expect(header.locator(".project-group-chip")).toHaveText("Clients");
  await expect(header.getByText("Session running")).toBeVisible();

  const more = header.getByRole("button", { name: "Actions for agent-pier" });
  const { width, height } = await more.boundingBox();
  expect(Math.round(width)).toBeGreaterThanOrEqual(44);
  expect(Math.round(height)).toBeGreaterThanOrEqual(44);
  await more.click();
  const sheet = sheetFor(page, "agent-pier");
  await expect(sheet.getByText("Current: Clients")).toBeVisible();
  await sheet.getByRole("menuitemradio", { name: "Games" }).click();
  await expect(header.locator(".project-group-chip")).toHaveText("Games");
  await more.click();
  await sheetFor(page, "agent-pier")
    .getByRole("menuitem", { name: "Remove from group" })
    .click();
  // Without a group the chip disappears; the Group fact says "No group".
  await expect(header.locator(".project-group-chip")).toHaveCount(0);
  await expect(page.locator(".project-fact", { hasText: "Group" })).toContainText(
    "No group",
  );

  // "New group …" opens the name field on the detail page and moves the project.
  await more.click();
  await sheetFor(page, "agent-pier")
    .getByRole("menuitem", { name: "New group …" })
    .click();
  const name = page.getByRole("textbox", { name: "Group name" });
  await name.fill("clients");
  await name.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "A group with this name already exists.",
  );
  await name.fill("Phone");
  await name.press("Enter");
  await expect(name).toHaveCount(0);
  await expect(header.locator(".project-group-chip")).toHaveText("Phone");
  await expect(more).toBeFocused();
  expect(server.document.assignments[repositoryPath]).toBe(
    server.document.groups.find((group) => group.name === "Phone").id,
  );

  // The launch bar sits at the bottom edge; scrolled to the end, the last card ends
  // above it.
  const bar = page.locator(".project-launch-bar");
  const launch = bar.getByRole("button", { name: "Start session in agent-pier" });
  await expect(launch).toBeVisible();
  const barBox = await bar.boundingBox();
  expect(Math.round(barBox.y + barBox.height)).toBe(844);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const last = await page.locator(".project-sessions").boundingBox();
  expect(last.y + last.height).toBeLessThanOrEqual(barBox.y);
});

test("an ungrouped project shows no group chip and no running chip when idle", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await groupsFixture(page);
  await page.goto(base + "/projects/m2");
  const header = page.locator(".settings-shell-header");
  await expect(header.getByRole("heading", { name: "notes", level: 1 })).toBeVisible();
  await expect(header.locator(".project-chips")).toHaveCount(0);
  await header.getByRole("button", { name: "Actions for notes" }).click();
  await expect(sheetFor(page, "notes").getByText("Current: No group")).toBeVisible();
});
