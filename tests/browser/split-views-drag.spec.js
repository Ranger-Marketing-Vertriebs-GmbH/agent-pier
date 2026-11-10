// Drag and drop in split views: a session or agent dropped on a single view creates a
// view with both; in a view an edge splits, the centre replaces, a header drag moves a
// pane and an item already there moves. OS file drops and unsaved edits keep working.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant } from "../helpers/assistant-chat-fixture.js";
import { dragOver, dropOn, paneTransfer } from "../helpers/pane-drag.js";
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
  C1 = "chat:a1:c1";
const extra = (id, name) => ({
  id,
  name,
  tool: "claude",
  cwd: `/fixture/${id}`,
  status: "running",
});
const s3 = extra("s3", "Docs site"),
  s4 = extra("s4", "API gateway"),
  s5 = extra("s5", "Release notes"),
  s6 = extra("s6", "Billing jobs");
const session = (id, tab = "terminal") => ({
  type: "pane",
  item: { kind: "session", id },
  tab,
});
const chatLeaf = (assistantId, conversationId) => ({
  type: "pane",
  item: { kind: "chat", assistantId, conversationId },
});
const item = (id) => ({ item: { kind: "session", id } });
// Six panes: row(col(s1, s2), row(col(s3, s4), col(s5, c1))).
const sixPanes = () =>
  split(
    "row",
    split("col", leaf.s1(), leaf.s2()),
    split(
      "row",
      split("col", session("s3"), session("s4")),
      split("col", session("s5"), leaf.c1()),
    ),
  );

const text = {
  en: {
    defaultName: "View 1",
    full: "The view is full (at most 6 panes).",
    hint: "6 of 6 panes",
    attachments: "Attachments",
  },
  de: {
    defaultName: "Ansicht 1",
    full: "Die Ansicht ist voll (höchstens 6 Bereiche).",
    hint: "6 von 6 Bereichen",
    attachments: "Anhänge",
  },
};

const sidebar = (page) => page.locator("aside.sidebar");
const sessionRow = (page, name) =>
  sidebar(page).locator(".sessions-group .session-item", { hasText: name });
const viewRow = (page, name) =>
  sidebar(page).locator(".views-group .views-sidebar-item", { hasText: name });
const agentRow = (page, name) =>
  sidebar(page).locator(".assistant-sidebar-item", { hasText: name });
const overlay = (page, key) => paneOf(page, key).locator(".drop-zone-overlay");
const layouts = (controls) => layoutWrites(controls).map((write) => write.body.layout);

// Opens readme.txt of the files pane `key` in the editor and types a draft.
async function editDraft(page, key, language) {
  const files = paneOf(page, key);
  await files.getByText("readme.txt", { exact: true }).click();
  await files.getByRole("button", { name: copy[language].open, exact: true }).click();
  await files
    .getByRole("textbox", { name: copy[language].editor("readme.txt") })
    .fill("draft");
}

for (const language of ["en", "de"]) {
  const t = text[language];
  const c = copy[language];
  test.describe(language, () => {
    test("dragging a second session onto the single session view creates a view with both", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, { language });
      await page.goto(`${baseURL}/sessions/s1/terminal`);
      await expect(sidebar(page).locator(".views-sidebar-item")).toHaveCount(1);
      await expect(page.locator(".session-workspace")).toBeVisible();
      const target = page.locator("main");
      await dragOver(target, "right", await paneTransfer(page, item("s2")));
      await expect(
        page.locator(".single-view-drop > .drop-zone-overlay"),
      ).toHaveAttribute("data-side", "right");
      await dropOn(target, "right", await paneTransfer(page, item("s2")));
      await expect(page).toHaveURL(`${baseURL}/views/v_new0000000000001`);
      expect(controls.writes.find((write) => write.method === "POST")).toEqual({
        method: "POST",
        body: { name: t.defaultName, layout: split("row", leaf.s1(), leaf.s2()) },
      });
      await expect(page.locator(".split-pane")).toHaveCount(2);
    });

    test("dropping the shown session on its own single view does nothing", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, { language });
      await page.goto(`${baseURL}/sessions/s1/terminal`);
      await expect(sidebar(page).locator(".views-sidebar-item")).toHaveCount(1);
      await expect(page.locator(".session-workspace")).toBeVisible();
      const target = page.locator("main");
      const zone = page.locator(".single-view-drop > .drop-zone-overlay");
      await dragOver(target, "left", await paneTransfer(page, item("s2")));
      await expect(zone).toHaveAttribute("data-side", "left");
      await dragOver(target, "left", await paneTransfer(page, item("s1")));
      await expect(zone).toHaveCount(0);
      await dropOn(target, "left", await paneTransfer(page, item("s1")));
      expect(controls.writes.filter((write) => write.method === "POST")).toEqual([]);
    });

    test("dragging an agent row onto a single chat resolves its main chat", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, {
        language,
        chat: {
          assistants: [
            chatAssistant({ id: "a1" }),
            chatAssistant({ id: "a2", name: "Travel planner" }),
          ],
        },
      });
      const agents = controls.agents;
      await page.route("**/api/assistants/a2/conversations", (route) => {
        agents.calls.push("/api/assistants/a2/conversations");
        const opened = { id: "c9", assistantId: "a2", main: true };
        agents.conversations = [...agents.conversations, opened];
        return route.fulfill({ json: opened });
      });
      await page.goto(`${baseURL}/agents/a1/chats/c1`);
      await expect(page.locator("#assistant-message")).toBeVisible();
      await expect(sidebar(page).locator(".views-sidebar-item")).toHaveCount(1);
      await dropOn(
        page.locator("main"),
        "left",
        await paneTransfer(page, { agent: { assistantId: "a2" } }),
      );
      await expect(page).toHaveURL(`${baseURL}/views/v_new0000000000001`);
      expect(agents.calls).toContain("/api/assistants/a2/conversations");
      expect(controls.writes.find((write) => write.method === "POST").body).toEqual({
        name: t.defaultName,
        layout: split("row", chatLeaf("a2", "c9"), leaf.c1()),
      });
    });

    test("the session row and the agent row are draggable; a team member row is not", async ({
      page,
    }) => {
      await splitViewFixture(page, {
        language,
        chat: {
          assistants: [
            chatAssistant({ id: "a1" }),
            chatAssistant({
              id: "m1a",
              name: "Reviewer",
              teamMemberId: "m1",
              lifetime: "permanent",
              parentAssistantId: "gone",
            }),
          ],
        },
      });
      await page.goto(baseURL + "/");
      await expect(sessionRow(page, "Refactor billing")).toHaveAttribute(
        "draggable",
        "true",
      );
      await expect(agentRow(page, "Home assistant")).toHaveAttribute("draggable", "true");
      await expect(agentRow(page, "Reviewer")).toBeVisible();
      await expect(agentRow(page, "Reviewer")).not.toHaveAttribute("draggable", /.*/);
      await page.setViewportSize({ width: 1100, height: 900 });
      await expect(sessionRow(page, "Refactor billing")).not.toHaveAttribute(
        "draggable",
        /.*/,
      );
    });

    test("an edge drop splits, a centre drop replaces, a header drop moves", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, {
        language,
        layout: split("row", leaf.s1(), leaf.c1()),
      });
      controls.sessions = [sessions.s1, sessions.s2, s3, s4];
      await page.goto(viewURL);
      await expect(page.locator(".split-pane")).toHaveCount(2);
      await dropOn(paneOf(page, C1), "bottom", await paneTransfer(page, item("s3")));
      await expect(page.locator(".split-pane")).toHaveCount(3);
      await dropOn(
        paneOf(page, "session:s3"),
        "center",
        await paneTransfer(page, item("s4")),
      );
      await expect(paneOf(page, "session:s4")).toBeVisible();
      await expect(paneOf(page, "session:s3")).toHaveCount(0);
      const header = paneOf(page, S1).locator(".session-pane-header");
      await expect(header).toHaveAttribute("draggable", "true");
      await dropOn(
        paneOf(page, C1),
        "left",
        await paneTransfer(page, { pane: { viewId, key: S1 } }),
      );
      await expect.poll(() => layoutWrites(controls).length).toBe(3);
      expect(layouts(controls)).toEqual([
        split("row", leaf.s1(), split("col", leaf.c1(), session("s3"))),
        split("row", leaf.s1(), split("col", leaf.c1(), session("s4"))),
        split("col", split("row", leaf.s1(), leaf.c1()), session("s4")),
      ]);
      await expect(page.locator(".split-pane")).toHaveCount(3);
    });

    test("a pane header dropped on another pane's centre swaps the two", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, {
        language,
        layout: split("row", leaf.s1(), leaf.c1(), 0.6),
      });
      await page.goto(viewURL);
      await expect(page.locator(".split-pane")).toHaveCount(2);
      await dropOn(
        paneOf(page, C1),
        "center",
        await paneTransfer(page, { pane: { viewId, key: S1 } }),
      );
      await expect
        .poll(() => layouts(controls))
        .toEqual([split("row", leaf.c1(), leaf.s1(), 0.6)]);
    });

    test("a dragged item already in the view moves", async ({ page }) => {
      const controls = await splitViewFixture(page, {
        language,
        layout: split("row", leaf.s1(), leaf.c1()),
      });
      await page.goto(viewURL);
      await expect(page.locator(".split-pane")).toHaveCount(2);
      await dropOn(paneOf(page, C1), "right", await paneTransfer(page, item("s1")));
      await expect
        .poll(() => layouts(controls))
        .toEqual([split("row", leaf.c1(), leaf.s1())]);
      await expect(page.locator(`.split-pane[data-pane-key="${S1}"]`)).toHaveCount(1);
    });

    test("a full view refuses a seventh pane", async ({ page }) => {
      const controls = await splitViewFixture(page, {
        language,
        layout: sixPanes(),
      });
      controls.sessions = [sessions.s1, sessions.s2, s3, s4, s5, s6];
      await page.goto(viewURL);
      await expect(page.locator(".split-pane")).toHaveCount(6);
      await expect(page.getByText(t.hint, { exact: true })).toBeVisible();
      const seventh = await paneTransfer(page, item("s6"));
      await dragOver(paneOf(page, S1), "center", seventh);
      await expect(overlay(page, S1)).toHaveAttribute("data-side", "center");
      await expect(overlay(page, S1)).toHaveText(t.full);
      await dragOver(paneOf(page, S1), "right", seventh);
      await expect(overlay(page, S1)).toHaveCount(0);
      await dragOver(paneOf(page, S1), "left", seventh);
      await expect(overlay(page, S1)).toHaveCount(0);
      await dropOn(paneOf(page, S1), "right", seventh);
      // Moving a pane adds none: no "full" label.
      await dragOver(
        paneOf(page, S1),
        "center",
        await paneTransfer(page, { pane: { viewId, key: "session:s2" } }),
      );
      await expect(overlay(page, S1)).toHaveAttribute("data-side", "center");
      await expect(overlay(page, S1)).toHaveText("");
      expect(layoutWrites(controls)).toEqual([]);
    });

    test("a split terminal pane never gets narrower than the minimum", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, {
        language,
        layout: split("row", leaf.s1(), split("col", leaf.s2(), leaf.c1())),
      });
      controls.sessions = [sessions.s1, sessions.s2, s3];
      await page.goto(viewURL);
      await expect(page.locator(".split-pane")).toHaveCount(3);
      await dropOn(paneOf(page, S1), "right", await paneTransfer(page, item("s3")));
      await expect(page.locator(".split-pane")).toHaveCount(4);
      const sizes = () =>
        page
          .locator(".split-pane")
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getBoundingClientRect().toJSON()),
          );
      for (const box of await sizes()) {
        expect(box.width).toBeGreaterThanOrEqual(280);
        expect(box.height).toBeGreaterThanOrEqual(220);
      }
      // The terminals load late (their own chunk) and take the focus when they mount,
      // so the divider is focused only once they are there.
      await expect(paneOf(page, S1).locator(".xterm")).toBeVisible();
      await expect(paneOf(page, "session:s3").locator(".xterm")).toBeVisible();
      // The outer divider: its left side holds s1 and s3, two panes of at least 280 px,
      // which bound it well above the general 15 %.
      const divider = page.getByRole("separator").first();
      const bound = await divider.getAttribute("aria-valuemin");
      expect(Number(bound)).toBeGreaterThan(15);
      await divider.focus();
      await page.keyboard.press("ArrowRight");
      await expect(divider).not.toHaveAttribute("aria-valuenow", bound);
      for (let step = 0; step < 12; step += 1) await page.keyboard.press("ArrowLeft");
      await expect(divider).toHaveAttribute("aria-valuenow", bound);
      const narrowest = Math.min(...(await sizes()).map((box) => box.width));
      expect(narrowest).toBeGreaterThanOrEqual(280);
      expect(narrowest).toBeLessThan(290);
    });

    test("the terminal stays connected when its pane is split or moved", async ({
      page,
    }) => {
      const controls = await splitViewFixture(page, {
        language,
        layout: split("row", leaf.s1(), leaf.c1()),
      });
      // After the fixture, whose own terminal route it replaces.
      const opened = [];
      await page.routeWebSocket("**/terminal", (socket) => {
        opened.push(new URL(socket.url()).pathname);
      });
      await page.goto(viewURL);
      await expect(paneOf(page, S1).locator(".xterm")).toBeVisible();
      await expect
        .poll(() => opened.filter((path) => path.includes("/s1/")))
        .toHaveLength(1);
      await dropOn(paneOf(page, S1), "bottom", await paneTransfer(page, item("s2")));
      await expect(paneOf(page, "session:s2").locator(".xterm")).toBeVisible();
      await dropOn(
        paneOf(page, "session:s2"),
        "left",
        await paneTransfer(page, { pane: { viewId, key: C1 } }),
      );
      await expect.poll(() => layoutWrites(controls).length).toBe(2);
      await expect(paneOf(page, S1).locator(".xterm")).toBeVisible();
      expect(opened.filter((path) => path.includes("/s1/"))).toHaveLength(1);
    });

    test("dropping OS files on a chat pane still attaches them", async ({ page }) => {
      const controls = await splitViewFixture(page, {
        language,
        layout: split("row", leaf.s1(), leaf.c1()),
      });
      await page.route(/\/api\/assistant-conversations\//, (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/attachment-policy"))
          return route.fulfill({
            json: { imageInput: true, maxBytes: 10485760, maxFiles: 5 },
          });
        if (url.pathname.endsWith("/attachments"))
          return route.fulfill({
            status: 201,
            json: {
              id: "file-1",
              name: "notes.txt",
              size: 7,
              type: "text/plain",
              kind: "text",
            },
          });
        return route.fallback();
      });
      await page.goto(viewURL);
      await expect(paneOf(page, C1).locator("textarea")).toBeVisible();
      const files = await paneTransfer(page, { files: ["notes.txt"] });
      await dragOver(paneOf(page, C1), "center", files);
      await expect(overlay(page, C1)).toHaveCount(0);
      await dropOn(paneOf(page, C1), "center", files);
      await expect(
        paneOf(page, C1)
          .getByRole("list", { name: t.attachments })
          .getByText("notes.txt"),
      ).toBeVisible();
      expect(layoutWrites(controls)).toEqual([]);
    });

    test("a centre drop on a pane with unsaved edits asks first", async ({ page }) => {
      const controls = await splitViewFixture(page, {
        language,
        layout: split("row", leaf.s1("files"), leaf.c1()),
      });
      await page.goto(viewURL);
      await editDraft(page, S1, language);
      await dropOn(paneOf(page, S1), "center", await paneTransfer(page, item("s2")));
      await expect(page.getByRole("heading", { name: c.unsaved })).toBeVisible();
      await page.getByRole("button", { name: c.cancel, exact: true }).click();
      await expect(paneOf(page, S1)).toBeVisible();
      expect(layoutWrites(controls)).toEqual([]);
    });

    test("closing a pane with unsaved edits asks first", async ({ page }) => {
      const controls = await splitViewFixture(page, {
        language,
        layout: split("row", leaf.s1("files"), leaf.c1()),
      });
      await page.goto(viewURL);
      await editDraft(page, S1, language);
      await page.getByRole("button", { name: c.removePane("Refactor billing") }).click();
      await expect(page.getByRole("heading", { name: c.unsaved })).toBeVisible();
      await page.getByRole("button", { name: c.cancel, exact: true }).click();
      await expect(page.locator(".split-pane")).toHaveCount(2);
      expect(layoutWrites(controls)).toEqual([]);
    });

    test("leaving a view with unsaved edits asks first", async ({ page }) => {
      const at = "2026-11-01T09:00:00.000Z";
      const controls = await splitViewFixture(page, {
        language,
        views: [
          {
            id: viewId,
            name: "Design review",
            layout: split("row", leaf.s1("files"), leaf.c1()),
            revision: 1,
            createdAt: at,
            usedAt: at,
          },
          {
            id: "v_fedcba9876543210",
            name: "Pairing",
            layout: leaf.s2(),
            revision: 1,
            createdAt: at,
            usedAt: at,
          },
        ],
      });
      await page.goto(viewURL);
      await expect(viewRow(page, "Pairing")).toBeVisible();
      // Opening the view marks it used; the draft starts after that write landed.
      await expect
        .poll(() =>
          controls.writes.some((write) => write.id === viewId && write.body?.used),
        )
        .toBe(true);
      await editDraft(page, S1, language);
      await viewRow(page, "Pairing").click();
      await expect(page.getByRole("heading", { name: c.unsaved })).toBeVisible();
      await page.getByRole("button", { name: c.cancel, exact: true }).click();
      await expect(page).toHaveURL(viewURL);
      expect(layoutWrites(controls)).toEqual([]);
    });
  });
}

test("a view made from the single session view keeps its tab", async ({ page }) => {
  const controls = await splitViewFixture(page);
  await page.goto(`${baseURL}/sessions/s1/files`);
  await expect(sidebar(page).locator(".views-sidebar-item")).toHaveCount(1);
  await expect(page.locator(".session-workspace")).toBeVisible();
  await dropOn(page.locator("main"), "right", await paneTransfer(page, item("s2")));
  await expect(page).toHaveURL(`${baseURL}/views/v_new0000000000001`);
  expect(controls.writes.find((write) => write.method === "POST").body.layout).toEqual(
    split("row", leaf.s1("files"), leaf.s2()),
  );
});

test("an empty view takes a dropped session", async ({ page }) => {
  const controls = await splitViewFixture(page, { layout: null });
  await page.goto(viewURL);
  const body = page.locator(".split-view-drop");
  await dragOver(body, "left", await paneTransfer(page, item("s2")));
  await expect(body.locator(".drop-zone-overlay")).toHaveAttribute("data-side", "center");
  await dropOn(body, "left", await paneTransfer(page, item("s2")));
  await expect.poll(() => layouts(controls)).toEqual([leaf.s2()]);
  await expect(page.locator(".split-pane")).toHaveCount(1);
});

test("a failed agent drop shows the error and keeps the layout", async ({ page }) => {
  const controls = await splitViewFixture(page, {
    layout: leaf.s1(),
    chat: {
      assistants: [
        chatAssistant({ id: "a1" }),
        chatAssistant({ id: "a2", name: "Travel planner" }),
      ],
    },
  });
  await page.route("**/api/assistants/a2/conversations", (route) =>
    route.fulfill({ status: 503, json: { error: "Agents are unavailable." } }),
  );
  await page.goto(viewURL);
  await expect(page.locator(".split-pane")).toHaveCount(1);
  await dropOn(
    paneOf(page, S1),
    "right",
    await paneTransfer(page, { agent: { assistantId: "a2" } }),
  );
  await expect(page.getByRole("alert")).toContainText("Agents are unavailable.");
  expect(layoutWrites(controls)).toEqual([]);
});

// A point 5 % from `side` of the locator's box (the centre for "center").
async function pointAt(locator, side) {
  const box = await locator.boundingBox();
  const [fx, fy] = {
    right: [0.95, 0.5],
    bottom: [0.5, 0.95],
    center: [0.5, 0.5],
  }[side];
  return [box.x + box.width * fx, box.y + box.height * fy];
}

// Real mouse drags: while hovering, the browser hides the drag data, so the zones
// decide from the payload the drag started with.
test("a real drag from the sidebar onto a full view offers only the centre", async ({
  page,
}) => {
  const controls = await splitViewFixture(page, { layout: sixPanes() });
  controls.sessions = [sessions.s1, sessions.s2, s3, s4, s5, s6];
  await page.goto(viewURL);
  await expect(page.locator(".split-pane")).toHaveCount(6);
  // The drag starts where the row is once the sidebar has settled: the agents group
  // above the sessions shows up later and moves them down.
  await expect(agentRow(page, "Home assistant")).toBeVisible();
  await expect(sidebar(page).locator(".sessions-group .session-item")).toHaveCount(6);
  const row = sessionRow(page, "Billing jobs");
  await row.hover();
  await page.mouse.down();
  await page.mouse.move(...(await pointAt(paneOf(page, S1), "center")), { steps: 8 });
  await expect(overlay(page, S1)).toHaveAttribute("data-side", "center");
  await expect(overlay(page, S1)).toHaveText(text.en.full);
  await page.mouse.move(...(await pointAt(paneOf(page, S1), "right")), { steps: 8 });
  await expect(overlay(page, S1)).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator(".split-pane")).toHaveCount(6);
  expect(layoutWrites(controls)).toEqual([]);
});

test("a real header drag moves a pane", async ({ page }) => {
  const controls = await splitViewFixture(page, {
    layout: split("row", leaf.s1(), leaf.c1()),
  });
  await page.goto(viewURL);
  await expect(page.locator(".split-pane")).toHaveCount(2);
  await paneOf(page, S1).locator(".session-pane-header h2").hover();
  await page.mouse.down();
  await page.mouse.move(...(await pointAt(paneOf(page, C1), "bottom")), { steps: 8 });
  await expect(overlay(page, C1)).toHaveAttribute("data-side", "bottom");
  await page.mouse.up();
  await expect
    .poll(() => layouts(controls))
    .toEqual([split("col", leaf.c1(), leaf.s1())]);
});

// Also the screenshot of a drag over a pane edge: SPLIT_DRAG_SCREENSHOT names its
// file, else it goes to the test's output folder.
test("a desktop drag over a pane edge in English", async ({ page }) => {
  const controls = await splitViewFixture(page, {
    layout: split("row", leaf.s1(), leaf.c1()),
  });
  controls.sessions = [sessions.s1, sessions.s2];
  await page.goto(viewURL);
  await expect(paneOf(page, C1).locator("textarea")).toBeVisible();
  await expect(paneOf(page, S1).locator(".xterm")).toBeVisible();
  await dragOver(paneOf(page, C1), "bottom", await paneTransfer(page, item("s2")));
  await expect(overlay(page, C1)).toHaveAttribute("data-side", "bottom");
  await page.screenshot({
    path: process.env.SPLIT_DRAG_SCREENSHOT || test.info().outputPath("split-drag.png"),
  });
});
