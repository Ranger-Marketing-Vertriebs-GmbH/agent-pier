import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// The chat's pinboard cards (history messages with `pinboard`), the deep link
// /agents/:id/pinboard and the closing of a pinboard link.
const entry = (id, name) => ({
  id,
  name,
  note: "",
  kind: "text",
  size: 10,
  state: "ok",
  fresh: false,
});
const list = (id, title, count = 3) => ({
  id,
  title,
  description: "",
  origin: null,
  archived: false,
  updatedAt: "2026-11-07T10:00:00.000Z",
  entries: Array.from({ length: count }, (_, n) => entry(`${id}-${n}`, `${id} ${n}.md`)),
});
const view = {
  fresh: 0,
  lists: [list("l2", "Scene images", 14), list("l1", "Episodes 6–10", 20)],
};
const card = (id, pinboard) => ({
  id: `pinboard:${id}`,
  role: "assistant",
  text: "",
  timestamp: Date.now(),
  pinboard,
});
const history = {
  messages: [
    { id: "question", role: "user", text: "Pin the scripts." },
    card("l1:r1", {
      listId: "l1",
      title: "Episodes 6–10",
      updated: 2,
      names: ["Episode 6", "Rough cut"],
    }),
    card("l3:r2", { listId: "l3", title: "Old list", added: 1, names: [], gone: true }),
  ],
  requests: [],
  stale: false,
};

async function open(page, path = "/agents/home/chats/dinner") {
  const state = await chatFixture(page, {
    conversations: [{ id: "dinner", assistantId: "home", title: "Dinner plans" }],
    history,
  });
  await page.route("**/api/assistants/home/pinboard", (route) =>
    route.fulfill({ json: view }),
  );
  await page.goto(baseURL + path);
  return state;
}

for (const [name, use] of [
  ["desktop", { viewport: { width: 1280, height: 900 } }],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
])
  test.describe(name, () => {
    test.use(use);
    const phone = name === "phone";

    test("a card opens the pinboard at its list; a deleted list is plain text", async ({
      page,
    }) => {
      await open(page);
      const card = page.getByRole("button", { name: "Open pinboard list Episodes 6–10" });
      await expect(card).toHaveText(
        "Episodes 6–10 · 2 files updated · Episode 6, Rough cut",
      );
      const gone = page.locator("[data-pinboard-card]", { hasText: "Old list" });
      await expect(gone).toContainText("deleted");
      await expect(page.getByRole("button", { name: /Old list/ })).toHaveCount(0);

      await card.click();
      const target = page.locator('.pinboard-list[data-list-id="l1"]');
      await expect(target).toBeVisible();
      if (phone) await expect(page.locator(".assistant-transcript")).toBeHidden();
      const scroller = await page
        .locator(phone ? ".assistant-pinboard-tab" : ".docked-panel-body")
        .boundingBox();
      await expect
        .poll(async () => (await target.boundingBox()).y - scroller.y)
        .toBeLessThan(60);
    });

    test("/agents/:id/pinboard opens the main chat with the pinboard", async ({
      page,
    }) => {
      await open(page, "/agents/home/pinboard");
      await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner\?pinboard=1$/);
      await expect(page.locator(".pinboard-list").first()).toBeVisible();
    });

    test("closing the pinboard drops its link from the address", async ({ page }) => {
      await open(page, "/agents/home/chats/dinner?pinboard=1&list=l1");
      await expect(page.locator('.pinboard-list[data-list-id="l1"]')).toBeVisible();
      if (phone) await page.getByRole("radio", { name: /Chat/ }).check({ force: true });
      else await page.getByRole("button", { name: "Close pinboard" }).click();
      await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner$/);
      await expect(page.locator(".pinboard-list")).toHaveCount(0);
    });
  });

test.describe("links and cards", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("Back leaves /agents/:id/pinboard for the page before it", async ({ page }) => {
    await open(page, "/settings");
    await page.goto(baseURL + "/agents/home/pinboard");
    await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner\?pinboard=1$/);
    await expect(page.locator(".pinboard-list").first()).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/settings$/);
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/settings$/);
  });

  test("/agents/:id/pinboard waits for the agents instead of calling it unavailable", async ({
    page,
  }) => {
    let release;
    const listed = new Promise((done) => (release = done));
    await open(page, "/settings");
    await page.route(/\/api\/assistants$/, async (route) => {
      await listed;
      await route.fallback();
    });
    await page.goto(baseURL + "/agents/home/pinboard");
    const agents = page.locator(".assistants-page");
    await expect(agents.getByRole("status")).toHaveText("Loading …");
    await page.waitForTimeout(500);
    await expect(agents.getByRole("status")).toHaveText("Loading …");
    await expect(page.getByText("This agent is not available.")).toHaveCount(0);
    release();
    await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner\?pinboard=1$/);
  });

  test("a user's own agent drops a pinboard link and shows its cards as plain text", async ({
    page,
  }) => {
    await chatFixture(page, {
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
      conversations: [{ id: "dinner", assistantId: "home", title: "Dinner plans" }],
      history,
    });
    await page.goto(baseURL + "/agents/home/chats/dinner?pinboard=1&list=l1");
    await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner$/);
    const card = page.locator("[data-pinboard-card]", { hasText: "Episodes 6–10" });
    await expect(card).toHaveText(
      "Episodes 6–10 · 2 files updated · Episode 6, Rough cut",
    );
    await expect(card).not.toContainText("deleted");
    await expect(
      page.locator("[data-pinboard-card]", { hasText: "Old list" }),
    ).toContainText("deleted");
    await expect(page.getByRole("button", { name: /Open pinboard list/ })).toHaveCount(0);
  });

  test("a list's time moves on while the pinboard stays open", async ({ page }) => {
    const now = Date.parse("2026-11-07T10:04:00.000Z");
    await page.clock.install({ time: now });
    await open(page, "/agents/home/chats/dinner?pinboard=1&list=l1");
    const time = page.locator('.pinboard-list[data-list-id="l1"] time');
    await expect(time).toHaveText("4 minutes ago");
    await page.clock.fastForward("02:00");
    await expect(time).toHaveText("6 minutes ago");
  });
});
