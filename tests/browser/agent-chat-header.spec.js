// The owner's compact agent chat header (agent pinboard): the chat selector under the
// agent name, the work goal and the events as header icons, and one row under the
// header with the Chat | Pinboard switch (phones) or a Pinboard button that docks the
// pinboard beside the chat (desktop). The restricted user's app keeps its event area.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";
import { userAppFixture } from "../helpers/user-app-fixture.js";

const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const desktop = { viewport: { width: 1280, height: 900 } };
const now = Date.now();
const iso = (ago) => new Date(now - ago).toISOString();

const goal = {
  id: "g",
  title: "Review cut",
  done: "The cut is reviewed",
  steps: "",
  state: "open",
  createdAt: 1,
};
const events = Array.from({ length: 3 }, (_, n) => ({
  id: `routine:r${n}`,
  source: "routine",
  name: `Network check ${n + 1}`,
  at: now - (n + 1) * 60_000,
  status: "done",
  firstLine: "All links up",
}));
const manyMessages = Array.from({ length: 40 }, (_, n) => ({
  id: `m${n}`,
  role: n % 2 ? "assistant" : "user",
  text: `Message ${n + 1} about the dinner plans for the week.`,
}));

const entry = (id, name, extra = {}) => ({
  id,
  name,
  note: "",
  version: 1,
  kind: "text",
  type: "text/markdown",
  size: 2048,
  state: "ok",
  fresh: false,
  updatedAt: iso(60_000),
  ...extra,
});
// Newest list first, as the view route answers (agent-pinboard-view.js).
const pinboard = {
  fresh: 2,
  lists: [
    {
      id: "l1",
      title: "Episodes 6–10",
      description: "Scripts for the next five episodes.",
      origin: { conversationId: "dinner", title: "Dinner plans" },
      archived: false,
      updatedAt: iso(4 * 60_000),
      entries: [
        entry("e1", "Episode 6.md", { note: "shortened", fresh: true }),
        entry("e2", "Rough cut.mp4", {
          kind: "video",
          type: "video/mp4",
          duration: 161,
          fresh: true,
        }),
        entry("e3", "Episode 5.md", { state: "unavailable" }),
        ...Array.from({ length: 14 }, (_, n) => entry(`x${n}`, `Draft ${n + 7}.md`)),
      ],
    },
    {
      id: "l2",
      title: "Scene images",
      description: "",
      origin: null,
      archived: false,
      updatedAt: iso(26 * 3600_000),
      entries: [
        entry("e4", "Board.png", { kind: "image", type: "image/png" }),
        ...Array.from({ length: 14 }, (_, n) =>
          entry(`y${n}`, `Scene ${n + 2}.png`, { kind: "image", type: "image/png" }),
        ),
      ],
    },
    {
      id: "l0",
      title: "Episodes 1–5",
      description: "",
      origin: null,
      archived: true,
      updatedAt: iso(9 * 86400_000),
      entries: [entry("e5", "Episode 1.md")],
    },
  ],
};

async function open(page, options = {}, path = "/agents/home/chats/dinner") {
  const { view = pinboard, ...rest } = options;
  const state = await chatFixture(page, {
    conversations: [{ id: "dinner", assistantId: "home", title: "Dinner plans" }],
    ...rest,
  });
  await page.route("**/api/assistants/home/pinboard", (route) =>
    route.fulfill({ json: view }),
  );
  await page.goto(baseURL + path);
  await expect(page.locator(".assistant-header")).toBeVisible();
  return state;
}

const transcript = (page) => page.locator(".assistant-transcript");
const switchRow = (page) => page.locator(".agent-chat-switch");
const pinboardTab = (page) =>
  page.getByRole("radio", { name: "Pinboard (2)", exact: true });

test.describe("on a phone", () => {
  test.use(phone);

  test("one row sits between the header and the transcript", async ({ page }) => {
    await open(page, { history: { messages: [], requests: [], goal, events } });
    await expect(switchRow(page)).toBeVisible();
    for (const old of [".agent-chat-bar", ".assistant-goal-line", ".agent-event-area"])
      await expect(page.locator(old)).toHaveCount(0);
    const header = await page.locator(".assistant-header").boundingBox();
    const row = await switchRow(page).boundingBox();
    const box = await transcript(page).boundingBox();
    expect(Math.abs(row.y - (header.y + header.height))).toBeLessThanOrEqual(1);
    expect(box.y).toBeLessThanOrEqual(header.y + header.height + row.height + 1);
    await expect(page.locator(".assistant-header")).toHaveCSS("height", "56px");
  });

  test("the chat title sits under the agent name and opens the Chats sheet", async ({
    page,
  }) => {
    await open(page);
    const status = page.locator(".assistant-header-status");
    const title = status.getByRole("button", {
      name: "Chats with Home assistant: Dinner plans",
    });
    await expect(title).toBeVisible();
    const name = await page.locator(".assistant-header h1").boundingBox();
    expect((await title.boundingBox()).y).toBeGreaterThan(name.y);
    await title.click();
    await expect(
      page.getByRole("dialog", { name: "Chats with Home assistant" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await switchRow(page).getByRole("button", { name: "Chats", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Chats with Home assistant" }),
    ).toBeVisible();
  });

  test("the chat title reads in full beside the goal, the events and Talk", async ({
    page,
  }) => {
    await open(page, {
      history: { messages: [], requests: [], stale: false, goal, events },
    });
    const header = page.locator(".assistant-header");
    await expect(header.locator(".talk-button")).toBeVisible();
    const title = header.locator(".agent-chat-title-button > span");
    await expect(title).toHaveText("Dinner plans");
    expect(await title.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    // The status is the dot alone, named and titled by its word.
    const status = header.locator(".assistant-header-status");
    await expect(status.locator(".assistant-header-label")).toHaveCount(0);
    const dot = status.getByRole("img", { name: "Ready" });
    await expect(dot).toHaveAttribute("title", "Ready");
    // Every header icon and the title are full touch targets.
    for (const icon of await header.locator(".assistant-header-icon").all()) {
      const box = await icon.boundingBox();
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(43.5);
    }
    const area = await title
      .locator("..")
      .evaluate((e) => parseFloat(getComputedStyle(e, "::after").height));
    expect(area).toBeGreaterThanOrEqual(44);
    // Chats and Summarize now do not share a glyph.
    const glyph = (name) =>
      switchRow(page)
        .getByRole("button", { name, exact: true })
        .locator("path")
        .getAttribute("d");
    expect(await glyph("Chats")).not.toBe(await glyph("Summarize now"));
  });

  test("the work goal opens a sheet whose Stop ends it", async ({ page }) => {
    const state = await open(page, {
      history: { messages: [], requests: [], stale: false, goal },
    });
    const stops = [];
    await page.route("**/goal/stop", (route) => {
      stops.push(route.request().method());
      return route.fulfill({ json: { goal: null } });
    });
    const button = page
      .locator(".assistant-header")
      .getByRole("button", { name: "Working until done: Review cut" });
    await button.click();
    const sheet = page.getByRole("dialog", { name: "Work goal" });
    await expect(sheet).toContainText("Working until done: Review cut");
    state.history = { ...state.history, goal: null };
    await sheet.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(button).toHaveCount(0);
    expect(stops).toEqual(["POST"]);
  });

  test("the events button counts, marks unread and opens the list", async ({ page }) => {
    await open(page, { history: { messages: [], requests: [], stale: false, events } });
    const button = page
      .locator(".assistant-header")
      .getByRole("button", { name: "Events: 3" });
    await expect(button).toContainText("3");
    await expect(button.getByRole("img", { name: "3 new" })).toBeVisible();
    await button.click();
    const sheet = page.getByRole("dialog", { name: "Events" });
    await expect(sheet.locator(".agent-event-row")).toHaveCount(3);
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(button.getByRole("img", { name: "3 new" })).toHaveCount(0);
  });

  test("the switch swaps the transcript for the pinboard and keeps the composer", async ({
    page,
  }) => {
    const state = await open(page, {
      history: { messages: manyMessages, requests: [], stale: false },
    });
    await expect(pinboardTab(page)).toBeVisible();
    await expect(page.getByText("Message 40 about")).toBeVisible();
    // The reader scrolls up (an input, so the transcript stops following its end).
    await transcript(page).evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      element.scrollTop = 300;
    });
    await expect.poll(() => transcript(page).evaluate((e) => e.scrollTop)).toBe(300);
    // The scroll event comes with the next frame.
    await page.evaluate(
      () =>
        new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    const chatTab = page.getByRole("radio", { name: "Chat", exact: true });
    await pinboardTab(page).check({ force: true });
    await expect(transcript(page)).toBeHidden();
    await expect(page.getByRole("heading", { name: "Episodes 6–10" })).toBeVisible();
    await chatTab.check({ force: true });
    await expect(transcript(page)).toBeVisible();
    expect(await transcript(page).evaluate((e) => e.scrollTop)).toBe(300);

    // The composer stays at the bottom under the pinboard and sends from there.
    await pinboardTab(page).check({ force: true });
    await expect(transcript(page)).toBeHidden();
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeVisible();
    const viewport = page.viewportSize();
    const box = await page.locator(".assistant-composer").boundingBox();
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 80);
    await composer.fill("Shorten episode 7");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => state.posted.length).toBe(1);
    expect(state.posted[0].text).toBe("Shorten episode 7");
    await expect(page.getByRole("heading", { name: "Episodes 6–10" })).toBeVisible();
  });

  test("the pinboard lists newest first with NEW, gone and archived files", async ({
    page,
  }) => {
    await open(page);
    await pinboardTab(page).check({ force: true });
    const lists = page.locator(".pinboard-list h3");
    await expect(lists).toHaveText(["Episodes 6–10", "Scene images"]);
    const first = page.locator('.pinboard-list[data-list-id="l1"]');
    await expect(first.locator(".pinboard-entry").filter({ hasText: "NEW" })).toHaveCount(
      2,
    );
    const gone = first.locator(".pinboard-entry").filter({ hasText: "Episode 5.md" });
    await expect(gone).toContainText("No longer available");
    await expect(gone.getByRole("button")).toBeDisabled();
    const archived = page.getByRole("button", { name: "Episodes 1–5 · done" });
    await expect(archived).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Episode 1.md")).toHaveCount(0);
    await archived.click();
    await expect(page.getByText("Episode 1.md")).toBeVisible();
    // The chat a list came from opens at 44px on a phone.
    const origin = first.getByRole("button", { name: "from Dinner plans" });
    expect((await origin.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
  });

  test("a pinboard link opens the tab scrolled to its list", async ({ page }) => {
    await open(page, {}, "/agents/home/chats/dinner?pinboard=1&list=l2");
    const list = page.locator('.pinboard-list[data-list-id="l2"]');
    await expect(list).toBeVisible();
    await expect(transcript(page)).toBeHidden();
    await expect(pinboardTab(page)).toBeChecked();
    const scroller = await page.locator(".assistant-pinboard-tab").boundingBox();
    await expect
      .poll(async () => (await list.boundingBox()).y - scroller.y)
      .toBeLessThan(40);
  });

  test("a user's own agent shows no pinboard", async ({ page }) => {
    await open(page, {
      assistants: [
        {
          id: "home",
          name: "Home assistant",
          instructions: "",
          model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
          revision: 1,
          effectiveRevision: 1,
          userAccess: { mode: "own", userId: "anna" },
        },
      ],
    });
    await expect(page.locator(".assistant-header-status")).toContainText("Dinner plans");
    await expect(page.getByRole("radio", { name: /Pinboard/ })).toHaveCount(0);
    await expect(switchRow(page)).toHaveCount(0);
  });
});

test.describe("a team member's chat on a phone", () => {
  test.use(phone);

  test("has no row under the header; a pin icon toggles the pinboard", async ({
    page,
  }) => {
    const member = {
      id: "member-0",
      name: "Network Architect",
      instructions: "",
      model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
      revision: 1,
      effectiveRevision: 1,
      teamMemberId: "member-0",
      teamId: "team",
      parentAssistantId: "home",
      lifetime: "permanent",
    };
    await chatFixture(page, {
      assistants: [
        {
          id: "home",
          name: "Home assistant",
          instructions: "",
          model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
          revision: 1,
          effectiveRevision: 1,
        },
        member,
      ],
      conversations: [
        { id: "dinner", assistantId: "home" },
        { id: "member-chat", assistantId: "member-0" },
      ],
      members: [
        {
          id: "member-0",
          kind: "member",
          teamId: "team",
          parentAssistantId: "home",
          assistantId: "member-0",
          name: "Network Architect",
          role: "Network specialist",
          assignment: "Know the network.",
          lifetime: "permanent",
          phase: "completed",
          conversationId: "member-chat",
        },
      ],
    });
    await page.route("**/api/assistants/member-0/pinboard", (route) =>
      route.fulfill({ json: pinboard }),
    );
    await page.goto(baseURL + "/agents/member-0/chats/member-chat");
    const header = page.locator(".assistant-header");
    await expect(header).toBeVisible();
    await expect(switchRow(page)).toHaveCount(0);
    // Only the member's own context strip sits between the header and the transcript.
    const bottom = await header.boundingBox();
    const context = await page.locator(".assistant-member-context").boundingBox();
    expect(Math.abs(context.y - (bottom.y + bottom.height))).toBeLessThanOrEqual(1);
    const box = await transcript(page).boundingBox();
    expect(Math.abs(box.y - (context.y + context.height))).toBeLessThanOrEqual(1);

    const pin = header.getByRole("button", { name: "Pinboard (2)" });
    await expect(pin).toContainText("2");
    const size = await pin.boundingBox();
    expect(size.width).toBeGreaterThanOrEqual(40);
    expect(size.height).toBeGreaterThanOrEqual(40);
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(transcript(page)).toBeHidden();
    await expect(page.getByRole("heading", { name: "Episodes 6–10" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    // The same icon leads back to the chat.
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await expect(transcript(page)).toBeVisible();
    await expect(page.locator(".assistant-pinboard-tab")).toHaveCount(0);
  });
});

test.describe("on a desktop", () => {
  test.use(desktop);

  test("the header's Pinboard button docks the pinboard beside the chat", async ({
    page,
  }) => {
    const state = await open(page);
    await expect(switchRow(page)).toHaveCount(0);
    const header = page.locator(".assistant-header");
    await expect(header.getByRole("button", { name: "New chat" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Summarize now" })).toBeVisible();
    const button = header.getByRole("button", { name: "Pinboard (2)" });
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    const panel = page.getByRole("complementary", { name: "Pinboard" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Scene images" })).toBeVisible();
    const chat = await transcript(page).boundingBox();
    const box = await panel.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(chat.x + chat.width - 1);
    await expect(transcript(page)).toBeVisible();

    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Shorten episode 7");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => state.posted.length).toBe(1);

    await panel.getByRole("button", { name: "Close pinboard" }).click();
    await expect(panel).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-expanded", "false");
  });

  test("a pinboard link opens the panel at its list", async ({ page }) => {
    await open(page, {}, "/agents/home/chats/dinner?pinboard=1&list=l2");
    const panel = page.getByRole("complementary", { name: "Pinboard" });
    const list = panel.locator('.pinboard-list[data-list-id="l2"]');
    await expect(list).toBeVisible();
    const body = await panel.locator(".docked-panel-body").boundingBox();
    await expect.poll(async () => (await list.boundingBox()).y - body.y).toBeLessThan(40);
  });
});

test.describe("in the user app", () => {
  test.use(phone);

  test("her chat keeps the event area row", async ({ page }) => {
    await userAppFixture(page, { areaEvents: { main: events.slice(0, 1) } });
    await page.goto(baseURL + "/agents/lotta/chats/main");
    await expect(page.locator(".agent-event-area")).toBeVisible();
    await expect(page.locator(".agent-chat-switch")).toHaveCount(0);
  });
});
