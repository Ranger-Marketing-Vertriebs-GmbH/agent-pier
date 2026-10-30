import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { groupsFixture, projectList, section } from "./projects-groups-fixture.js";
import { repositoryPath } from "./projects-fixture.js";

// A long project name or `owner/repo` in one row must not widen every row of the
// list: names ellipsize, "● Running" stays whole inside the pane. In English.
test.use({ locale: "en-GB" });

const longName = "a-project-with-a-really-long-name-that-never-fits-the-list";
const runningName = "server-migration-with-an-unusually-long-project-name";
const projects = [
  // The fixture's running session works in this folder, so the row shows "Running".
  { id: "m1", name: runningName, cwd: repositoryPath, kind: "directory", entryCount: 0 },
  {
    id: "m2",
    name: longName,
    cwd: "/work/long",
    kind: "directory",
    entryCount: 0,
    remote:
      "https://github.com/an-organisation-with-a-long-name/an-equally-long-repo.git",
  },
];

async function expectListFits(page) {
  const list = projectList(page);
  const scroller = list.locator(".project-list-scroller");
  const status = list.locator(".project-row-status");
  await expect(status).toHaveText("Running");
  const overflow = await scroller.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const pane = await scroller.boundingBox();
  for (const locator of [
    status,
    list.locator(".project-row").filter({ hasText: longName }),
  ]) {
    const { x, width } = await locator.boundingBox();
    expect(x).toBeGreaterThanOrEqual(pane.x);
    expect(x + width).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
  }
  // Long names and subtitles are cut with an ellipsis instead of widening the row.
  for (const text of [longName, runningName, "an-organisation-with-a-long-name/"]) {
    const node = list.locator(".project-row :is(strong, small)", { hasText: text });
    expect(await node.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await node.evaluate((el) => getComputedStyle(el).textOverflow)).toBe(
      "ellipsis",
    );
  }
}

for (const viewport of [
  { label: "the narrowest desktop width", width: 701, height: 720 },
  { label: "a wide desktop", width: 1440, height: 900 },
  { label: "a phone", width: 390, height: 844 },
])
  test(`long names never push "Running" out of the list on ${viewport.label}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { server } = await groupsFixture(page, { projects });
    // Grouped rows are indented, which leaves them the least room.
    server.document = {
      version: 1,
      groups: [{ id: "seed_1", name: "Clients" }],
      assignments: { [repositoryPath]: "seed_1", "/work/long": "seed_1" },
    };
    await page.goto(base + "/projects");
    await expect(section(page, "Clients")).toBeVisible();
    await expectListFits(page);
  });

const longOwner = "a-long-organisation-name-for-sales-and-marketing";
const originProjects = [
  {
    id: "m1",
    name: "agent-pier",
    cwd: repositoryPath,
    kind: "directory",
    entryCount: 0,
    remote: `https://github.com/${longOwner}/agent-pier.git`,
  },
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `m${index + 10}`,
    name: `proj-${String(index).padStart(2, "0")}`,
    cwd: `/work/proj-${index}`,
    kind: "directory",
    entryCount: 0,
    remote: `https://github.com/someone/proj-${index}.git`,
  })),
];
const inside = (inner, outer) =>
  inner.x >= outer.x - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5;
const rowOf = (list, name) =>
  list
    .locator(".project-row")
    .filter({ has: list.page().getByText(name, { exact: true }) });

test("Origin view: a long owner/repo keeps Running and ⋯ in the pane, headers stay clear", async ({
  page,
}) => {
  await page.setViewportSize({ width: 701, height: 600 });
  await groupsFixture(page, { projects: originProjects });
  await page.goto(base + "/projects");
  await page.getByRole("radio", { name: "Origin" }).check();
  const list = projectList(page);
  const scroller = list.locator(".project-list-scroller");
  const row = rowOf(list, "agent-pier");
  await row.locator(".project-row-main").click();
  await expect(row).toHaveClass(/selected/);
  await expect(row.locator(".project-row-status")).toHaveText("Running");
  expect(await scroller.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  const pane = await scroller.boundingBox();
  for (const part of [
    row,
    row.locator(".project-row-status"),
    row.getByRole("button", { name: "Actions for agent-pier" }),
  ])
    expect(inside(await part.boundingBox(), pane)).toBe(true);
  const subtitle = row.locator("small", { hasText: `${longOwner}/` });
  expect(await subtitle.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

  // A long owner name ellipsizes before its count.
  const header = section(page, longOwner);
  const title = header.locator(".project-section-title");
  expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const count = await header.locator(".project-section-count").boundingBox();
  expect(inside(count, pane)).toBe(true);

  // At rest, the first row of every section sits fully below its header.
  for (const owner of [longOwner, "someone"]) {
    const block = list.locator(".project-section").filter({
      has: page.getByRole("button", { name: new RegExp(`^${owner}\\s*\\d+$`) }),
    });
    const head = await block.locator(".project-section-header").boundingBox();
    const first = await block.locator(".project-row").first().boundingBox();
    expect(first.y).toBeGreaterThanOrEqual(head.y + head.height - 0.5);
  }

  // A row scrolled to the top (keyboard, find, focus) stops below the sticky header.
  const target = rowOf(list, "proj-05");
  await target.evaluate((node) => node.scrollIntoView({ block: "start" }));
  expect(await scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const sticky = await section(page, "someone").boundingBox();
  const scrolled = await target.boundingBox();
  expect(scrolled.y).toBeGreaterThanOrEqual(sticky.y + sticky.height - 0.5);
  // The header sticks to the top edge, so no scrolled row peeks out above it.
  const scrollport = await scroller.boundingBox();
  expect(Math.abs(sticky.y - scrollport.y)).toBeLessThanOrEqual(0.5);
});
