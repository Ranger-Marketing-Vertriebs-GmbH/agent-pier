// The sidebar's Views group and the click rule: a sidebar row, a search result or an
// in-app tap never replaces a pane; it focuses the item where a view holds it (the open
// view first, else the most recently used one), else opens its single view.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import {
  layoutWrites,
  leaf,
  paneOf,
  sessions,
  split,
  splitViewFixture,
  threePanes,
  viewId,
} from "../helpers/split-views-browser.js";

test.use({ viewport: { width: 1440, height: 1000 } });

const otherId = "v_fedcba9876543210";
const S1 = "session:s1",
  S2 = "session:s2",
  C1 = "chat:a1:c1";
const s9 = {
  id: "s9",
  name: "Loose ends",
  tool: "claude",
  cwd: "/fixture/loose",
  status: "running",
};
const view = (id, name, layout, usedAt) => ({
  id,
  name,
  layout,
  revision: 1,
  createdAt: "2026-11-01T08:00:00.000Z",
  usedAt,
});
// "Shop" (3 panes, used last) and "Pairing" (s2 alone, used earlier).
const twoViews = () => [
  view(viewId, "Shop", threePanes(), "2026-11-01T10:00:00.000Z"),
  view(
    otherId,
    "Pairing",
    split("row", leaf.s2(), leaf.s1()),
    "2026-11-01T09:00:00.000Z",
  ),
];

const text = {
  en: {
    group: "Views",
    newView: "New view",
    defaultName: "View 1",
    secondName: "View 2",
    shownInView: "Shown in this view",
    shopLabel: "Shop, 3 panes",
    empty: /This view is empty/,
    search: "Search",
    openAlone: "Open alone",
    paneMenu: (name) => `More for ${name}`,
  },
  de: {
    group: "Ansichten",
    newView: "Neue Ansicht",
    defaultName: "Ansicht 1",
    secondName: "Ansicht 2",
    shownInView: "In dieser Ansicht",
    shopLabel: "Shop, 3 Bereiche",
    empty: /Diese Ansicht ist leer/,
    search: "Suchen",
    openAlone: "Einzeln öffnen",
    paneMenu: (name) => `Mehr zu ${name}`,
  },
};

const sidebar = (page) => page.locator("aside.sidebar");
const sessionRow = (page, name) =>
  sidebar(page).locator(".sessions-group .session-item", { hasText: name });
const viewRow = (page, name) =>
  sidebar(page).locator(".views-group .views-sidebar-item", { hasText: name });
const groupHeads = (page) =>
  sidebar(page)
    .locator(".sidebar-scroll .sidebar-group")
    .evaluateAll((groups) =>
      // Top-level groups only: agent groups nest inside the Agents group.
      groups
        .filter((group) => !group.parentElement.closest(".sidebar-group"))
        .map((group) =>
          [...group.classList].find(
            (name) => name.endsWith("-group") && name !== "sidebar-group",
          ),
        ),
    );
const focusedFlash = async (page, key) => {
  const host = paneOf(page, key).locator(".split-pane-host");
  await expect(host).toHaveClass(/split-pane-flash/);
  await expect(host).toHaveClass(/split-pane-focused/);
};

for (const language of ["en", "de"]) {
  const t = text[language];
  test.describe(language, () => {
    test("the views group sits between Inbox and Agents", async ({ page }) => {
      await splitViewFixture(page, { language, views: twoViews() });
      await page.goto(baseURL + "/");
      const group = sidebar(page).locator(".views-group");
      await expect(group.getByRole("button", { name: t.group })).toBeVisible();
      await expect(
        group.locator(".sidebar-group-toggle .sidebar-group-count"),
      ).toHaveText("2");
      await expect(viewRow(page, "Shop")).toHaveAttribute("aria-label", t.shopLabel);
      await expect(viewRow(page, "Shop")).toContainText("3");
      await expect(sidebar(page).locator(".assistant-chats-group")).toBeVisible();
      expect(await groupHeads(page)).toEqual([
        "views-group",
        "assistant-chats-group",
        "sessions-group",
      ]);
      const inbox = await sidebar(page).locator(".sidebar-inbox").boundingBox();
      const views = await group.boundingBox();
      expect(views.y).toBeGreaterThan(inbox.y);
    });

    test("+ creates an empty view and opens it", async ({ page }) => {
      const controls = await splitViewFixture(page, { language, views: [] });
      await page.goto(baseURL + "/");
      await sidebar(page).getByRole("button", { name: t.newView }).click();
      await expect(page).toHaveURL(`${baseURL}/views/v_new0000000000001`);
      expect(controls.writes[0]).toEqual({
        method: "POST",
        body: { name: t.defaultName, layout: null },
      });
      await expect(page.getByText(t.empty)).toBeVisible();
      await expect(viewRow(page, t.defaultName)).toHaveAttribute("aria-current", "page");
    });

    test("clicking a session that is in the open view focuses its pane", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, { language, views: twoViews() });
      await page.goto(`${baseURL}/views/${viewId}`);
      await expect(page.locator(".split-pane")).toHaveCount(3);
      await sessionRow(page, "Shop UI").click();
      await focusedFlash(page, S2);
      await expect(page).toHaveURL(`${baseURL}/views/${viewId}`);
      expect(layoutWrites(controls)).toEqual([]);
    });

    test("clicking a session in another view opens the most recently used one", async ({
      page,
    }) => {
      // The more recently used view ("Shop") comes second, so list order alone
      // would pick "Pairing".
      const [shop, pairing] = twoViews();
      const controls = await splitViewFixture(page, {
        language,
        views: [
          pairing,
          shop,
          view("v_0000000000000003", "Empty", null, "2026-11-01T11:00:00.000Z"),
        ],
      });
      await page.goto(`${baseURL}/views/v_0000000000000003`);
      await expect(page.getByText(t.empty)).toBeVisible();
      await sessionRow(page, "Shop UI").click();
      await expect(page).toHaveURL(`${baseURL}/views/${viewId}`);
      await focusedFlash(page, S2);
      expect(layoutWrites(controls)).toEqual([]);
    });

    test("returning to a view does not replay an earlier focus", async ({ page }) => {
      const [shop, pairing] = twoViews();
      await splitViewFixture(page, {
        language,
        views: [
          pairing,
          shop,
          view("v_0000000000000003", "Empty", null, "2026-11-01T11:00:00.000Z"),
        ],
      });
      await page.goto(`${baseURL}/views/v_0000000000000003`);
      await expect(page.getByText(t.empty)).toBeVisible();
      await sessionRow(page, "Shop UI").click();
      await expect(page).toHaveURL(`${baseURL}/views/${viewId}`);
      await focusedFlash(page, S2);
      await viewRow(page, "Empty").click();
      await expect(page.getByText(t.empty)).toBeVisible();
      await viewRow(page, "Shop").click();
      await expect(page).toHaveURL(`${baseURL}/views/${viewId}`);
      const host = paneOf(page, S2).locator(".split-pane-host");
      await expect(host).toBeVisible();
      // Checked at once: a replayed request would flash and focus the pane right now.
      expect(await host.getAttribute("class")).not.toMatch(/split-pane-(flash|focused)/);
      await expect(paneOf(page, S1).locator(".split-pane-host")).toHaveClass(
        /split-pane-focused/,
      );
      expect(await host.evaluate((node) => node.contains(document.activeElement))).toBe(
        false,
      );
    });

    test("rows the open view shows are marked", async ({ page }) => {
      const controls = await splitViewFixture(page, { language, views: twoViews() });
      controls.sessions = [sessions.s1, sessions.s2, s9];
      await page.goto(`${baseURL}/views/${otherId}`);
      await expect(page.locator(".split-pane")).toHaveCount(2);
      await expect(sessionRow(page, "Shop UI")).toHaveClass(/in-view/);
      await expect(sessionRow(page, "Shop UI")).toContainText(t.shownInView);
      await expect(sessionRow(page, "Loose ends")).not.toHaveClass(/in-view/);
      const agent = sidebar(page).locator(".assistant-sidebar-item", {
        hasText: "Home assistant",
      });
      await expect(agent).not.toHaveClass(/in-view/);
      await page.goto(`${baseURL}/views/${viewId}`);
      await expect(agent).toHaveClass(/in-view/);
      await expect(agent).toHaveAttribute("aria-label", new RegExp(`${t.shownInView}$`));
      await page.goto(`${baseURL}/sessions/s9`);
      await expect(sessionRow(page, "Shop UI")).not.toHaveClass(/in-view/);
    });

    test("+ waits for the saved views before naming a new one", async ({ page }) => {
      const controls = await splitViewFixture(page, {
        language,
        views: [view(viewId, t.defaultName, null, "2026-11-01T10:00:00.000Z")],
      });
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      await page.route("**/api/views", async (route) => {
        if (route.request().method() === "GET") await held;
        return route.fallback();
      });
      await page.goto(baseURL + "/");
      const plus = sidebar(page).getByRole("button", { name: t.newView });
      await expect(plus).toBeDisabled();
      release();
      await expect(plus).toBeEnabled();
      await plus.click();
      await expect
        .poll(() => controls.writes.find((write) => write.method === "POST"))
        .toEqual({
          method: "POST",
          body: { name: t.secondName, layout: null },
        });
    });

    test("clicking a session in no view opens the single view", async ({ page }) => {
      const controls = await splitViewFixture(page, { language, views: twoViews() });
      controls.sessions = [sessions.s1, sessions.s2, s9];
      await page.goto(`${baseURL}/views/${viewId}`);
      await expect(page.locator(".split-pane")).toHaveCount(3);
      await sessionRow(page, "Loose ends").click();
      await expect(page).toHaveURL(`${baseURL}/sessions/s9/terminal`);
    });

    test("search and an agent row follow the same rule", async ({ page }) => {
      const controls = await splitViewFixture(page, {
        language,
        views: [view(viewId, "Shop", threePanes(), "2026-11-01T10:00:00.000Z")],
      });
      // What the search reads while it is open: nothing besides the workspace.
      await page.route(
        /\/api\/(ssh-accesses|mcp-servers|secrets|repositories|pipelines|memory\/projects)(\?|$)/,
        (route) => route.fulfill({ json: {} }),
      );
      await page.goto(`${baseURL}/views/${viewId}`);
      await expect(page.locator(".split-pane")).toHaveCount(3);
      await sidebar(page).locator(".sidebar-search").click();
      const dialog = page.getByRole("dialog", { name: t.search });
      await dialog.getByRole("combobox").fill("Refactor billing");
      await dialog
        .getByRole("option", { name: /Refactor billing/ })
        .first()
        .click();
      await focusedFlash(page, S1);
      await expect(page).toHaveURL(`${baseURL}/views/${viewId}`);
      await sidebar(page)
        .locator(".assistant-sidebar-item", { hasText: "Home assistant" })
        .click();
      await focusedFlash(page, C1);
      await expect(page).toHaveURL(`${baseURL}/views/${viewId}`);
      expect(layoutWrites(controls)).toEqual([]);
    });

    test("Open alone opens the single view and keeps the view", async ({ page }) => {
      const controls = await splitViewFixture(page, { language, views: twoViews() });
      await page.goto(`${baseURL}/views/${viewId}`);
      await expect(page.locator(".split-pane")).toHaveCount(3);
      await page.getByRole("button", { name: t.paneMenu("Refactor billing") }).click();
      await page.getByRole("menuitem", { name: t.openAlone }).click();
      await expect(page).toHaveURL(`${baseURL}/sessions/s1/terminal`);
      expect(layoutWrites(controls)).toEqual([]);
      await expect(viewRow(page, "Shop")).toBeVisible();
    });

    test("a direct URL opens the single view", async ({ page }) => {
      await splitViewFixture(page, { language, views: twoViews() });
      await page.goto(`${baseURL}/sessions/s1`);
      await expect(page).toHaveURL(/\/sessions\/s1/);
      await expect(page.locator(".split-pane")).toHaveCount(0);
      await expect(page.locator(".split-view-page")).toHaveCount(0);
    });

    test("phones and tablets show no views group and clicks open the single view", async ({
      page,
    }) => {
      await splitViewFixture(page, { language, views: twoViews() });
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.goto(baseURL + "/");
      await expect(sidebar(page).locator(".sessions-group")).toBeVisible();
      await expect(sidebar(page).locator(".views-group")).toHaveCount(0);
      await sessionRow(page, "Shop UI").click();
      await expect(page).toHaveURL(/\/sessions\/s2/);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(baseURL + "/");
      await expect(page.locator(".views-group")).toHaveCount(0);
    });
  });
}
