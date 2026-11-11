import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import {
  home,
  setupAssistantSettings,
  emitChange,
} from "../helpers/assistant-settings-browser.js";

async function setup(page, shared) {
  const data = shared || {
    assistants: [
      home({ id: "home", name: "Developer" }),
      home({
        id: "reviewer",
        name: "Reviewer",
        teamMemberId: "member",
        parentAssistantId: "home",
        lifetime: "permanent",
      }),
      home({ id: "calendar", name: "Calendar" }),
    ],
    groups: [],
    activity: {},
    sequence: 0,
  };
  const state = await setupAssistantSettings(page, { assistants: data.assistants });
  await page.route("**/api/assistants", (route) =>
    route.fulfill({
      json: {
        assistants: data.assistants,
        conversations: [],
        agentGroups: data.groups,
        activity: data.activity,
        models: [{ id: "router", name: "Router", available: true }],
      },
    }),
  );
  await page.route(/\/api\/assistant-groups(?:\/[^/]+(?:\/order)?)?$/, async (route) => {
    const req = route.request(),
      body = req.postDataJSON();
    const parts = new URL(req.url()).pathname.split("/");
    let group = data.groups.find((g) => g.id === parts[3]);
    if (parts.length === 3) {
      group = {
        id: `group-${++data.sequence}`,
        name: body.name,
        revision: 1,
        assistantIds: [],
      };
      data.groups.push(group);
    } else if (req.method() === "DELETE")
      data.groups = data.groups.filter((g) => g !== group);
    else if (parts[4] === "order") {
      const index = data.groups.indexOf(group),
        next = index + (body.direction === "up" ? -1 : 1);
      [data.groups[index], data.groups[next]] = [data.groups[next], group];
    } else {
      if (body.revision !== group.revision)
        return route.fulfill({
          status: 409,
          json: { messageKey: "assistants.conflict" },
        });
      group.name = body.name;
      group.revision++;
    }
    await route.fulfill({ json: group });
  });
  await page.route(/\/api\/assistants\/[^/]+\/group$/, async (route) => {
    const body = route.request().postDataJSON(),
      id = new URL(route.request().url()).pathname.split("/")[3];
    for (const group of data.groups)
      group.assistantIds = group.assistantIds.filter((a) => a !== id);
    data.groups.find((g) => g.id === body.groupId)?.assistantIds.push(id);
    await route.fulfill({ json: { assistantId: id, groupId: body.groupId } });
  });
  return { data, state };
}
const main = (page) => page.getByRole("main");
const area = (page, name) =>
  main(page)
    .locator(".agent-area-section")
    .filter({ has: page.getByRole("button", { name, exact: true }) });
async function add(page, name) {
  await main(page).getByRole("button", { name: "New group", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New group", exact: true });
  await dialog.getByLabel("Group name").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function move(page, name, group) {
  await main(page)
    .getByRole("button", { name: `Actions for ${name}`, exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: group, exact: true }).click();
}

test("groups create, rename, reorder, move whole families and delete without losing agents", async ({
  page,
}, info) => {
  const { data } = await setup(page);
  await page.goto(baseURL + "/agents");
  await add(page, "Development");
  await add(page, "Organization");
  await move(page, "Developer", "Development");
  await move(page, "Calendar", "Organization");
  await expect(area(page, "Development")).toContainText("Developer");
  await expect(area(page, "Development")).toContainText("Reviewer");
  await expect(
    main(page).getByRole("button", { name: "Actions for Reviewer" }),
  ).toHaveCount(0);
  await main(page)
    .getByRole("button", { name: "Actions for Organization", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect(main(page).locator(".agent-area-section").first()).toContainText(
    "Organization",
  );
  await main(page)
    .getByRole("button", { name: "Actions for Development", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Rename group", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Group name").fill("Engineering");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(area(page, "Engineering")).toContainText("Reviewer");
  data.activity.reviewer = { state: "waiting", pendingApprovals: 1 };
  await emitChange(page);
  await area(page, "Engineering")
    .getByRole("button", { name: "Engineering", exact: true })
    .click();
  await expect(
    area(page, "Engineering").getByRole("img", { name: "Needs your attention" }),
  ).toBeVisible();
  await expect(
    area(page, "Engineering").getByText("Reviewer", { exact: true }),
  ).not.toBeVisible();
  await page.reload();
  await expect(
    area(page, "Engineering").getByRole("button", { name: "Engineering", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    main(page).getByRole("button", { name: "New group", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("agent-groups-desktop.png"),
    fullPage: true,
  });
  await main(page)
    .getByRole("button", { name: "Actions for Engineering", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Delete group", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete group “Engineering”?" });
  await expect(dialog).toContainText("The agents are kept");
  await dialog.getByRole("button", { name: "Delete group", exact: true }).click();
  await expect(area(page, "Ungrouped")).toContainText("Developer");
  await expect(area(page, "Ungrouped")).toContainText("Reviewer");
  expect(data.assistants).toHaveLength(3);
});

test("a pushed group change reaches another page and the sidebar includes the whole team", async ({
  page,
  context,
}) => {
  const { data } = await setup(page);
  data.groups.push({ id: "work", name: "Work", revision: 1, assistantIds: ["home"] });
  const second = await context.newPage();
  await setup(second, data);
  await page.goto(baseURL + "/agents");
  await second.goto(baseURL + "/agents");
  // The same group contains the root in the sidebar; its members remain under it.
  const side = page
    .locator(".agent-area-section")
    .filter({ has: page.locator(".agent-area-sidebar-work-group") });
  await expect(side.getByRole("button", { name: /Developer.*model/ })).toBeVisible();
  await side.getByRole("button", { name: /Show.*member/ }).click();
  await expect(side.getByRole("button", { name: /Reviewer.*model/ })).toBeVisible();
  await move(page, "Developer", "Ungrouped");
  await emitChange(second);
  await expect(area(second, "Ungrouped")).toContainText("Reviewer");
  await expect(area(second, "Work")).toContainText("No agents in this group yet.");
  await expect(side.getByRole("button", { name: /Developer.*model/ })).toHaveCount(0);
  await second.close();
});

test("phone group controls fit and the wizard offers a group", async ({ page }, info) => {
  const { data } = await setup(page);
  data.groups.push({
    id: "work",
    name: "Development",
    revision: 1,
    assistantIds: ["home"],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/agents");
  await add(page, "Personal");
  await move(page, "Calendar", "Personal");
  await expect(area(page, "Personal")).toContainText("Calendar");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await expect(
    main(page).getByRole("button", { name: "New group", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("agent-groups-phone.png"),
    fullPage: true,
  });
  await page.goto(baseURL + "/agents?new=1");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Group", { exact: true })).toBeVisible();
  await page.getByLabel("Group", { exact: true }).selectOption("work");
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("work");
});

test("renaming retains the draft and offers reload or explicit overwrite on a live conflict", async ({
  page,
}) => {
  const { data } = await setup(page);
  data.groups.push({ id: "work", name: "Work", revision: 1, assistantIds: ["home"] });
  await page.goto(baseURL + "/agents");
  await main(page).getByRole("button", { name: "Actions for Work", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename group", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rename group", exact: true });
  await dialog.getByLabel("Group name").fill("My draft");
  data.groups[0].name = "Changed elsewhere";
  data.groups[0].revision++;
  await emitChange(page);
  await expect(dialog.getByLabel("Group name")).toHaveValue("My draft");
  await expect(
    dialog.getByRole("button", { name: "Reload", exact: false }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Overwrite anyway", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(area(page, "My draft")).toBeVisible();
  expect(data.groups[0].revision).toBe(3);
});
