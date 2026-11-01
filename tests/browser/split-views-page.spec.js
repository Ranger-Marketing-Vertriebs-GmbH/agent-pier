// A saved split view at /views/:id: panes side by side with live sessions and agent
// chats, saved tabs and ratios, stale panes, renaming, presence and the narrow note.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { navigateTo } from "../helpers/navigation.js";
import {
  copy,
  layoutWrites,
  leaf,
  paneOf,
  sessions,
  split,
  splitViewFixture,
  viewId,
} from "../helpers/split-views-browser.js";

test.use({ viewport: { width: 1440, height: 1000 } });

const viewURL = `${baseURL}/views/${viewId}`;
const S1 = "session:s1",
  S2 = "session:s2",
  C1 = "chat:a1:c1";

for (const language of ["en", "de"]) {
  const text = copy[language];
  test.describe(language, () => {
    test("a view shows its panes side by side and keeps each session's tab", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, { language });
      await page.goto(viewURL);
      await expect(page.locator(".split-pane")).toHaveCount(3);
      await expect(paneOf(page, S1).locator(".session-pane-header h2")).toHaveText(
        "Refactor billing",
      );
      await expect(paneOf(page, S2).locator(".session-pane-header h2")).toHaveText(
        "Shop UI",
      );
      await expect(paneOf(page, C1).locator(".assistant-header h2")).toHaveText(
        "Home assistant",
      );
      await paneOf(page, S1).getByRole("button", { name: "Chat", exact: true }).click();
      await expect.poll(() => layoutWrites(controls).length).toBe(1);
      expect(layoutWrites(controls)[0].body.layout.a).toEqual(leaf.s1("chat"));
      await page.reload();
      await expect(
        paneOf(page, S1).getByRole("button", { name: "Chat", exact: true }),
      ).toHaveClass(/selected/);
    });

    test("dragging a divider resizes the panes and saves the ratio once", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, { language });
      await page.goto(viewURL);
      await expect(page.locator(".split-pane")).toHaveCount(3);
      const before = (await paneOf(page, S1).boundingBox()).width;
      await page.getByRole("separator").first().focus();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => layoutWrites(controls).length).toBe(1);
      expect(layoutWrites(controls)[0].body.layout.ratio).toBe(0.55);
      await expect
        .poll(async () => (await paneOf(page, S1).boundingBox()).width)
        .toBeGreaterThan(before);
    });

    test("× removes a pane and its sibling takes the space", async ({ page }) => {
      const controls = await splitViewFixture(page, { language });
      await page.goto(viewURL);
      await expect(page.locator(".split-pane")).toHaveCount(3);
      await page.getByRole("button", { name: text.removePane("Shop UI") }).click();
      await expect(page.locator(".split-pane")).toHaveCount(2);
      expect(layoutWrites(controls).map((write) => write.body.layout)).toEqual([
        split("row", leaf.s1(), leaf.c1()),
      ]);
      expect(controls.sessionPosts.filter((path) => path.includes("/s2"))).toEqual([]);
    });

    test("a removed session shows its notice and the other pane keeps working", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, { language });
      controls.sessions = [sessions.s1];
      await page.goto(viewURL);
      await expect(paneOf(page, S2)).toContainText(text.removed);
      const composer = paneOf(page, C1).locator("textarea");
      await composer.fill("Still here");
      await expect(composer).toHaveValue("Still here");
      expect(layoutWrites(controls)).toEqual([]);
      await paneOf(page, S2).getByRole("button", { name: text.removeStale }).click();
      await expect.poll(() => layoutWrites(controls).length).toBe(1);
      await expect(page.locator(".split-pane")).toHaveCount(2);
    });

    test("the view name renames in place", async ({ page }) => {
      const controls = await splitViewFixture(page, { language });
      await page.goto(viewURL);
      await page.getByRole("button", { name: "Design review", exact: true }).click();
      const field = page.getByRole("textbox", { name: text.nameLabel });
      await field.fill("Shop");
      await field.press("Enter");
      await expect(page.getByRole("heading", { name: "Shop", level: 1 })).toBeVisible();
      expect(controls.writes.filter((write) => write.body?.name)).toEqual([
        { method: "PATCH", id: viewId, body: { name: "Shop" } },
      ]);
      await page.getByRole("button", { name: "Shop", exact: true }).click();
      await field.fill("");
      await field.press("Enter");
      await expect(page.getByRole("alert")).toContainText("A view needs a name.");
      await expect(field).toBeVisible();
    });

    test("opening a view marks it used", async ({ page }) => {
      const controls = await splitViewFixture(page, { language });
      await page.goto(viewURL);
      await expect.poll(() => controls.writes.length).toBeGreaterThan(0);
      expect(controls.writes[0]).toEqual({
        method: "PATCH",
        id: viewId,
        body: { used: true },
      });
    });

    test("presence reports every pane", async ({ page, liveStub }) => {
      const controls = await splitViewFixture(page, { language });
      controls.pushDevices = 1;
      await page.goto(viewURL);
      await expect(page.locator(".split-pane")).toHaveCount(3);
      const reported = () => [
        ...new Set([
          ...controls.presence,
          ...liveStub
            .received()
            .filter((frame) => frame.op === "presence")
            .map((frame) => frame.route),
        ]),
      ];
      await expect
        .poll(reported)
        .toEqual(
          expect.arrayContaining(["/sessions/s1", "/sessions/s2", "/agents/a1/chats/c1"]),
        );
    });

    test("two terminals in a view do not steal focus", async ({ page }) => {
      await splitViewFixture(page, {
        language,
        layout: split("row", leaf.s1(), split("col", leaf.s2(), leaf.c1())),
      });
      await page.goto(viewURL);
      await expect(paneOf(page, S2).locator(".xterm")).toBeVisible();
      await expect(paneOf(page, S1).locator(".split-pane-focused")).toHaveCount(1);
      const insideSecond = () =>
        page.evaluate(() =>
          Boolean(document.activeElement?.closest('[data-pane-key="session:s2"] .xterm')),
        );
      expect(await insideSecond()).toBe(false);
      await paneOf(page, S2).locator(".session-pane-header h2").click();
      await expect(paneOf(page, S2).locator(".split-pane-focused")).toHaveCount(1);
      await expect(paneOf(page, S1).locator(".split-pane-focused")).toHaveCount(0);
    });

    test("ids stay unique in a view", async ({ page }) => {
      await splitViewFixture(page, {
        language,
        layout: split("row", leaf.s1("chat"), split("col", leaf.s2("files"), leaf.c1())),
      });
      await page.goto(viewURL);
      const files = paneOf(page, S2);
      await files.getByText("readme.txt", { exact: true }).click();
      await files.getByRole("button", { name: text.open, exact: true }).click();
      await expect(
        files.getByRole("textbox", { name: text.editor("readme.txt") }),
      ).toBeVisible();
      await expect(paneOf(page, C1).locator("textarea")).toBeVisible();
      const duplicates = await page.evaluate(() => {
        const seen = new Map();
        for (const element of document.querySelectorAll("[id]"))
          seen.set(element.id, (seen.get(element.id) || 0) + 1);
        return [...seen].filter(([, count]) => count > 1).map(([id]) => id);
      });
      expect(duplicates).toEqual([]);
    });

    test("unsaved edits in a pane ask before the pane closes or the view is left", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, { language });
      await page.goto(viewURL);
      const files = paneOf(page, S2);
      await files.getByText("readme.txt", { exact: true }).click();
      await files.getByRole("button", { name: text.open, exact: true }).click();
      const editor = files.getByRole("textbox", { name: text.editor("readme.txt") });
      await editor.fill("draft");
      // Another pane's navigation does not ask about this pane's document.
      await paneOf(page, S1).getByRole("button", { name: "Chat", exact: true }).click();
      await expect.poll(() => layoutWrites(controls).length).toBe(1);
      await expect(page.getByRole("heading", { name: text.unsaved })).toHaveCount(0);
      await page.getByRole("button", { name: text.removePane("Shop UI") }).click();
      await expect(page.getByRole("heading", { name: text.unsaved })).toBeVisible();
      await page.getByRole("button", { name: text.cancel, exact: true }).click();
      await expect(page.locator(".split-pane")).toHaveCount(3);
      expect(layoutWrites(controls)).toHaveLength(1);
      await navigateTo(page, text.settings);
      await expect(page.getByRole("heading", { name: text.unsaved })).toBeVisible();
      await page.getByRole("button", { name: text.cancel, exact: true }).click();
      await expect(page).toHaveURL(viewURL);
      await expect(editor).toHaveText("draft");
    });

    test("a pane whose terminal socket is down says so", async ({ page }) => {
      await splitViewFixture(page, { language });
      await page.routeWebSocket("**/terminal", (socket) => socket.close());
      await page.goto(viewURL);
      await expect(
        paneOf(page, S1).locator(".session-pane-header .session-pane-offline"),
      ).toContainText(text.disconnected);
      await expect(paneOf(page, S2).locator(".session-pane-offline")).toHaveCount(0);
    });

    test("deleting a view asks about a pane's unsaved edits first", async ({ page }) => {
      const controls = await splitViewFixture(page, { language });
      await page.goto(viewURL);
      const files = paneOf(page, S2);
      await files.getByText("readme.txt", { exact: true }).click();
      await files.getByRole("button", { name: text.open, exact: true }).click();
      const editor = files.getByRole("textbox", { name: text.editor("readme.txt") });
      await editor.fill("draft");
      await page.getByRole("button", { name: text.deleteView, exact: true }).click();
      const confirm = page.getByRole("dialog").filter({ hasText: "Design review" });
      await confirm.getByRole("button", { name: text.deleteView, exact: true }).click();
      await expect(page.getByRole("heading", { name: text.unsaved })).toBeVisible();
      await page.getByRole("button", { name: text.cancel, exact: true }).click();
      await expect(page).toHaveURL(viewURL);
      await expect(editor).toHaveText("draft");
      expect(controls.writes.filter((write) => write.method === "DELETE")).toEqual([]);
    });

    test("deleting a view without unsaved edits removes it and opens the start page", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, { language });
      await page.goto(viewURL);
      await expect(page.locator(".split-pane")).toHaveCount(3);
      await page.getByRole("button", { name: text.deleteView, exact: true }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: text.deleteView, exact: true })
        .click();
      await expect(page).toHaveURL(`${baseURL}/`);
      await expect
        .poll(() => controls.writes.filter((write) => write.method === "DELETE"))
        .toEqual([{ method: "DELETE", id: viewId, body: null }]);
    });

    test("a files pane keeps its toolbar inside the pane", async ({ page }) => {
      await splitViewFixture(page, { language });
      await page.goto(viewURL);
      const files = paneOf(page, S2);
      const actions = files.locator(".explorer-toolbar button:visible");
      await expect(actions.first()).toBeVisible();
      const pane = await files.boundingBox();
      for (const box of await actions.evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().toJSON()),
      )) {
        expect(box.left).toBeGreaterThanOrEqual(pane.x - 1);
        expect(box.right).toBeLessThanOrEqual(pane.x + pane.width + 1);
      }
    });

    test("a failed views read offers a retry", async ({ page }) => {
      const controls = await splitViewFixture(page, { language });
      controls.failRead = true;
      await page.goto(viewURL);
      await expect(page.getByRole("alert")).toContainText("Views unavailable");
      controls.failRead = false;
      await page.getByRole("button", { name: text.retry, exact: true }).click();
      await expect(page.locator(".split-pane")).toHaveCount(3);
    });

    test("an unknown view is not found", async ({ page }) => {
      await splitViewFixture(page, { language });
      await page.goto(`${baseURL}/views/v_ffffffffffffffff`);
      await expect(page.getByRole("heading", { name: text.notFound })).toBeVisible();
    });

    test("below 1151 px a view shows its first pane with a note", async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 900 });
      await splitViewFixture(page, { language });
      await page.goto(viewURL);
      await expect(page.locator(".split-pane")).toHaveCount(1);
      await expect(page.locator(".split-pane .session-pane-header h2")).toHaveText(
        "Refactor billing",
      );
      await expect(page.getByText(text.narrowNote)).toBeVisible();
    });
  });
}

test("a 3-pane view in English", async ({ page }) => {
  test.skip(!process.env.SPLIT_VIEW_SCREENSHOT, "screenshot on demand");
  await splitViewFixture(page, { language: "en" });
  await page.goto(viewURL);
  await expect(page.locator(".split-pane")).toHaveCount(3);
  await expect(paneOf(page, C1).locator("textarea")).toBeVisible();
  await page.screenshot({ path: process.env.SPLIT_VIEW_SCREENSHOT });
});
