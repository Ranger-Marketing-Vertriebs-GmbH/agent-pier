import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { home, emitChange } from "../helpers/assistant-settings-browser.js";
import { setupAgentOrder as setup } from "../helpers/agent-order-browser.js";
import { chatAssistant } from "../helpers/assistant-chat-fixture.js";
import { paneOf, splitViewFixture, viewId } from "../helpers/split-views-browser.js";

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
  await expect(
    page.locator("[aria-live=polite]", { hasText: "Writer moved" }),
  ).toHaveText(/Writer moved to position 1 of 3/);
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

test("a team member shown on its own has only Move up and Move down", async ({
  page,
}) => {
  const data = await setup(page);
  data.assistants.push(
    home({
      id: "reviewer",
      name: "Reviewer",
      teamMemberId: "m1",
      parentAssistantId: "gone",
      lifetime: "permanent",
    }),
  );
  await page.goto(baseURL + "/agents");
  await expect
    .poll(() => names(page))
    .toEqual(["Developer", "Calendar", "Writer", "Reviewer"]);
  await row(page, "Reviewer")
    .getByRole("button", { name: "Actions for Reviewer", exact: true })
    .click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect
    .poll(() => names(page))
    .toEqual(["Developer", "Calendar", "Reviewer", "Writer"]);
  await expect
    .poll(() => data.saves)
    .toEqual([["home", "calendar", "reviewer", "writer"]]);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  // A long press, then a drag from `from` to just inside the top of `to` (CDP touch).
  async function touchDrag(page, from, to, hold = 700) {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      });
    const start = await from.boundingBox();
    const end = await to.boundingBox();
    const x = start.x + start.width / 2;
    await touch("touchStart", x, start.y + start.height / 2);
    await page.waitForTimeout(hold);
    for (let y = start.y + start.height / 2; y > end.y + 6; y -= 10)
      await touch("touchMove", x, y);
    await touch("touchMove", x, end.y + 6);
    await touch("touchEnd");
  }

  test("a long press and a drag reorder the owner's sidebar", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "touch input is dispatched over CDP");
    const data = await setup(page);
    await page.goto(baseURL + "/agents");
    await expect.poll(() => names(page)).toEqual(["Developer", "Calendar", "Writer"]);
    await touchDrag(page, row(page, "Writer").locator("strong"), row(page, "Developer"));
    await expect.poll(() => names(page)).toEqual(["Writer", "Developer", "Calendar"]);
    await expect.poll(() => data.saves).toEqual([["writer", "home", "calendar"]]);
  });

  test("a long press on a row's ⋯ button starts no drag", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "touch input is dispatched over CDP");
    const data = await setup(page);
    await page.goto(baseURL + "/agents");
    await expect.poll(() => names(page)).toEqual(["Developer", "Calendar", "Writer"]);
    await touchDrag(
      page,
      row(page, "Writer").getByRole("button", { name: "Actions for Writer" }),
      row(page, "Developer"),
    );
    await expect(page.locator(".agent-order-dragging")).toHaveCount(0);
    expect(data.saves).toEqual([]);
    expect(await names(page)).toEqual(["Developer", "Calendar", "Writer"]);
  });
});

test("with groups, a real mouse drag still takes an agent row into a split view", async ({
  page,
}) => {
  const controls = await splitViewFixture(page, {
    chat: {
      assistants: [
        chatAssistant({ id: "a1" }),
        chatAssistant({ id: "a2", name: "Travel planner" }),
      ],
      agentGroups: [{ id: "work", name: "Work", revision: 1, assistantIds: ["a1"] }],
    },
  });
  const agents = controls.agents;
  await page.route("**/api/assistants/a2/conversations", (route) => {
    const opened = { id: "c9", assistantId: "a2", main: true };
    agents.conversations = [...agents.conversations, opened];
    return route.fulfill({ json: opened });
  });
  let saves = 0;
  await page.route("**/api/assistant-order", (route) => {
    saves++;
    return route.fulfill({ json: { ids: [] } });
  });
  await page.goto(`${baseURL}/views/${viewId}`);
  await expect(paneOf(page, "session:s1")).toBeVisible();
  await page
    .locator("aside.sidebar .assistant-sidebar-item", { hasText: "Travel planner" })
    .dragTo(paneOf(page, "session:s1"));
  await expect(paneOf(page, "chat:a2:c9")).toBeVisible();
  expect(saves).toBe(0);
});
