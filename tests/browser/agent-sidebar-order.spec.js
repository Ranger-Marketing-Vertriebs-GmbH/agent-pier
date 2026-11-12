import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import {
  home,
  setupAssistantSettings,
  emitChange,
} from "../helpers/assistant-settings-browser.js";

// The server's order as agent-order.js keeps it: the stored ids, applied by the page.
async function setup(page, shared) {
  const data = shared || {
    assistants: [
      home({ id: "home", name: "Developer" }),
      home({ id: "calendar", name: "Calendar" }),
      home({ id: "writer", name: "Writer" }),
    ],
    groups: [],
    order: [],
    saves: [],
    assigns: [],
  };
  await setupAssistantSettings(page, { assistants: data.assistants });
  await page.route("**/api/assistants", (route) =>
    route.fulfill({
      json: {
        assistants: data.assistants,
        conversations: [],
        agentGroups: data.groups,
        agentOrder: data.order,
        activity: {},
        models: [{ id: "router", name: "Router", available: true }],
      },
    }),
  );
  await page.route("**/api/assistant-order", async (route) => {
    const { ids } = route.request().postDataJSON();
    data.saves.push(ids);
    data.order = ids;
    await route.fulfill({ json: { ids } });
  });
  await page.route(/\/api\/assistants\/[^/]+\/group$/, async (route) => {
    const body = route.request().postDataJSON(),
      id = new URL(route.request().url()).pathname.split("/")[3];
    data.assigns.push({ id, ...body });
    for (const group of data.groups)
      group.assistantIds = group.assistantIds.filter((a) => a !== id);
    data.groups.find((g) => g.id === body.groupId)?.assistantIds.push(id);
    await route.fulfill({ json: { assistantId: id, groupId: body.groupId } });
  });
  return data;
}
const rows = (scope) => scope.locator(".assistant-sidebar-row");
const pageOf = (scope) => (typeof scope.page === "function" ? scope.page() : scope);
const row = (scope, name) =>
  rows(scope).filter({
    has: pageOf(scope).locator("strong", { hasText: new RegExp(`^${name}$`) }),
  });
const names = (scope) => rows(scope).locator("strong").allTextContents();
// The upper quarter of a row: a drop there lands before it.
const above = { position: { x: 40, y: 6 } };

test("dragging an agent in the plain list saves the owner's order for every view", async ({
  page,
  context,
}, info) => {
  const data = await setup(page);
  const second = await context.newPage();
  await setup(second, data);
  await page.goto(baseURL + "/agents");
  await second.goto(baseURL + "/agents");
  await expect.poll(() => names(page)).toEqual(["Developer", "Calendar", "Writer"]);
  await row(page, "Writer")
    .getByRole("button", { name: /^Writer/ })
    .dragTo(row(page, "Developer"), { targetPosition: above.position });
  await expect.poll(() => names(page)).toEqual(["Writer", "Developer", "Calendar"]);
  await expect.poll(() => data.saves).toEqual([["writer", "home", "calendar"]]);
  await expect(page.getByRole("status").filter({ hasText: "Writer moved" })).toHaveText(
    /Writer moved to position 1 of 3/,
  );
  await page.screenshot({
    path: info.outputPath("agent-sidebar-order.png"),
    clip: await sidebarClip(page),
  });
  // The other open view follows the pushed list.
  await emitChange(second);
  await expect.poll(() => names(second)).toEqual(["Writer", "Developer", "Calendar"]);
  await second.close();
  await page.reload();
  await expect.poll(() => names(page)).toEqual(["Writer", "Developer", "Calendar"]);
});

async function sidebarClip(page) {
  const box = await page.locator(".assistant-sidebar-row").first().boundingBox();
  const list = await page
    .locator(".session-list")
    .filter({ has: page.locator(".assistant-sidebar-row") })
    .boundingBox();
  return {
    x: 0,
    y: Math.max(0, box.y - 80),
    width: Math.ceil(list.x + list.width + 16),
    height: Math.ceil(list.height + 120),
  };
}

test("Move up and Move down in the agent's menu reorder it from the keyboard", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto(baseURL + "/agents");
  await expect.poll(() => names(page)).toEqual(["Developer", "Calendar", "Writer"]);
  const trigger = row(page, "Calendar").getByRole("button", {
    name: "Actions for Calendar",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Move up", exact: true }).press("Enter");
  await expect.poll(() => names(page)).toEqual(["Calendar", "Developer", "Writer"]);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  // The first agent cannot move further up.
  await expect(page.getByRole("menuitem", { name: "Move up", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("menuitem", { name: "Move down", exact: true }).press("Enter");
  await expect.poll(() => names(page)).toEqual(["Developer", "Calendar", "Writer"]);
  await expect
    .poll(() => data.saves)
    .toEqual([
      ["calendar", "home", "writer"],
      ["home", "calendar", "writer"],
    ]);
});

test("dropping an agent into another group moves it there at the drop position", async ({
  page,
}) => {
  const data = await setup(page);
  data.groups.push({ id: "work", name: "Work", revision: 1, assistantIds: ["home"] });
  await page.goto(baseURL + "/agents");
  const work = page
    .locator(".agent-area-section")
    .filter({ has: page.locator(".agent-area-sidebar-work-group") });
  await expect.poll(() => names(work)).toEqual(["Developer"]);
  await row(page, "Calendar")
    .getByRole("button", { name: /^Calendar/ })
    .dragTo(row(work, "Developer"), { targetPosition: above.position });
  await expect.poll(() => names(work)).toEqual(["Calendar", "Developer"]);
  await expect
    .poll(() => data.assigns)
    .toEqual([{ id: "calendar", groupId: "work", previousGroupId: null }]);
  await expect.poll(() => data.saves).toEqual([["calendar", "home", "writer"]]);
});
