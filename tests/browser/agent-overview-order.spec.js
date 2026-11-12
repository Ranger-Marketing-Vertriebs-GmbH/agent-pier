import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { home, emitChange } from "../helpers/assistant-settings-browser.js";
import { setupAgentOrder as setup } from "../helpers/agent-order-browser.js";

// Agents › All agents lists the agents in the owner's order, like the sidebar, and
// reorders them with the same gestures and the same saved order.
const main = (page) => page.getByRole("main");
const entries = (scope) => scope.locator(".agents-hub-order");
// The row of an agent that starts its drag (its members are not part of it).
const handle = (scope, name) =>
  scope.locator(".agents-hub-order-handle").filter({
    has: scope.page().locator(".list-row-label", { hasText: new RegExp(`^${name}$`) }),
  });
// Every row of the overview: the agents and the members under them.
const overview = (page) =>
  main(page).locator(".agents-hub-order .list-row-label").allTextContents();
const sidebar = (page) =>
  page.locator("aside.sidebar .assistant-sidebar-row strong").allTextContents();
// Near the top left of a row: a drop there lands before it, and a drag starts on its
// name rather than on its buttons.
const top = { x: 40, y: 6 };
const name = { x: 40, y: 24 };

async function menu(page, agent, item) {
  await main(page)
    .getByRole("button", { name: `Actions for ${agent}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("the overview shows the sidebar's order and a drag there reorders both", async ({
  page,
  context,
}, info) => {
  const data = await setup(page);
  data.order = ["calendar", "home", "writer"];
  const second = await context.newPage();
  await setup(second, data);
  await page.goto(baseURL + "/agents");
  await second.goto(baseURL + "/agents");
  await expect.poll(() => overview(page)).toEqual(["Calendar", "Developer", "Writer"]);
  await expect.poll(() => sidebar(page)).toEqual(["Calendar", "Developer", "Writer"]);
  await handle(main(page), "Writer").dragTo(handle(main(page), "Calendar"), {
    sourcePosition: name,
    targetPosition: top,
  });
  await expect.poll(() => overview(page)).toEqual(["Writer", "Calendar", "Developer"]);
  await expect.poll(() => data.saves).toEqual([["writer", "calendar", "home"]]);
  await expect.poll(() => sidebar(page)).toEqual(["Writer", "Calendar", "Developer"]);
  await expect(
    page.locator("[aria-live=polite]", { hasText: "Writer moved" }),
  ).toHaveText(/Writer moved to position 1 of 3/);
  await page.screenshot({ path: info.outputPath("agent-overview-order.png") });
  // Another open view follows the pushed list; a reload keeps the order.
  await emitChange(second);
  await expect.poll(() => overview(second)).toEqual(["Writer", "Calendar", "Developer"]);
  await expect.poll(() => sidebar(second)).toEqual(["Writer", "Calendar", "Developer"]);
  await second.close();
  await page.reload();
  await expect.poll(() => overview(page)).toEqual(["Writer", "Calendar", "Developer"]);
});

test("Move up and Move down in the overview's menu save the order", async ({ page }) => {
  const data = await setup(page);
  await page.goto(baseURL + "/agents");
  await expect.poll(() => overview(page)).toEqual(["Developer", "Calendar", "Writer"]);
  await menu(page, "Calendar", "Move up");
  await expect.poll(() => overview(page)).toEqual(["Calendar", "Developer", "Writer"]);
  await expect.poll(() => sidebar(page)).toEqual(["Calendar", "Developer", "Writer"]);
  await main(page)
    .getByRole("button", { name: "Actions for Calendar", exact: true })
    .click();
  await expect(page.getByRole("menuitem", { name: "Move up", exact: true })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await menu(page, "Developer", "Move down");
  await expect.poll(() => overview(page)).toEqual(["Calendar", "Writer", "Developer"]);
  await expect
    .poll(() => data.saves)
    .toEqual([
      ["calendar", "home", "writer"],
      ["calendar", "writer", "home"],
    ]);
});

test("a lead moves with its members, and a drop into another group moves it there", async ({
  page,
}) => {
  const data = await setup(page);
  data.assistants.push(
    home({
      id: "reviewer",
      name: "Reviewer",
      teamMemberId: "m1",
      parentAssistantId: "home",
      lifetime: "permanent",
    }),
  );
  data.groups.push({ id: "work", name: "Work", revision: 1, assistantIds: ["writer"] });
  await page.goto(baseURL + "/agents");
  const work = main(page)
    .locator(".agent-area-section")
    .filter({ has: page.locator(".agent-area-overview-work-group") });
  await expect
    .poll(() => overview(page))
    .toEqual(["Writer", "Developer", "Reviewer", "Calendar"]);
  // The member has no Move up or Move down: it stays under its lead.
  await expect(
    main(page).getByRole("button", { name: "Actions for Reviewer", exact: true }),
  ).toHaveCount(0);
  await menu(page, "Calendar", "Move up");
  await expect
    .poll(() => overview(page))
    .toEqual(["Writer", "Calendar", "Developer", "Reviewer"]);
  await handle(main(page), "Developer").dragTo(handle(work, "Writer"), {
    sourcePosition: name,
    targetPosition: top,
  });
  await expect
    .poll(() => overview(page))
    .toEqual(["Developer", "Reviewer", "Writer", "Calendar"]);
  await expect(entries(work)).toHaveCount(2);
  await expect
    .poll(() => data.assigns)
    .toEqual([{ id: "home", groupId: "work", previousGroupId: null }]);
  await expect
    .poll(() => data.saves)
    .toEqual([
      ["writer", "calendar", "home"],
      ["home", "writer", "calendar"],
    ]);
});

test("the agents of users keep their heading and move among themselves", async ({
  page,
}) => {
  const data = await setup(page);
  const shared = { mode: "shared", members: [] };
  data.assistants.push(
    home({ id: "anna", name: "Anna's agent", userAccess: shared }),
    home({ id: "ben", name: "Ben's agent", userAccess: shared }),
  );
  await page.goto(baseURL + "/agents");
  await expect
    .poll(() => overview(page))
    .toEqual(["Developer", "Calendar", "Writer", "Anna's agent", "Ben's agent"]);
  await main(page)
    .getByRole("button", { name: "Actions for Anna's agent", exact: true })
    .click();
  await expect(page.getByRole("menuitem", { name: "Move up", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("menuitem", { name: "Move down", exact: true }).click();
  await expect
    .poll(() => overview(page))
    .toEqual(["Developer", "Calendar", "Writer", "Ben's agent", "Anna's agent"]);
  await expect(
    main(page).getByRole("heading", { name: "Agents of users" }),
  ).toBeVisible();
  await expect
    .poll(() => data.saves)
    .toEqual([["home", "calendar", "writer", "ben", "anna"]]);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("a long press and a drag reorder the overview", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input is dispatched over CDP");
    const data = await setup(page);
    await page.goto(baseURL + "/agents");
    await expect.poll(() => overview(page)).toEqual(["Developer", "Calendar", "Writer"]);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      });
    const start = await handle(main(page), "Writer")
      .locator(".list-row-label")
      .boundingBox();
    const end = await handle(main(page), "Developer").boundingBox();
    const x = start.x + 10;
    await touch("touchStart", x, start.y + start.height / 2);
    await page.waitForTimeout(700);
    for (let y = start.y; y > end.y + 6; y -= 10) await touch("touchMove", x, y);
    await touch("touchMove", x, end.y + 6);
    await touch("touchEnd");
    await expect.poll(() => overview(page)).toEqual(["Writer", "Developer", "Calendar"]);
    await expect.poll(() => data.saves).toEqual([["writer", "home", "calendar"]]);
  });
});
