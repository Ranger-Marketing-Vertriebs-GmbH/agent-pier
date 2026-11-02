import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// The hint in an older chat whose last turns ran on another model family
// (server/features/assistants/model-hints.js): New chat opens a fresh chat, Dismiss
// puts the hint away. English, on a phone.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const text = "This chat began with another model. Its history can affect the answers.";
const earlier = [
  { id: "u0", role: "user", text: "Plan three dinners.", timestamp: 1, requestId: "q0" },
  { id: "a0", role: "assistant", text: "Here they are.", timestamp: 2, runId: "t0" },
];
const history = (extra = {}) => ({
  messages: earlier,
  requests: [
    {
      id: "q0",
      state: "completed",
      text: earlier[0].text,
      attempt: { id: "t0", state: "completed" },
    },
  ],
  stale: false,
  ...extra,
});
const hint = (page) => page.locator(".assistant-model-hint");
const synced = (page, id) =>
  page.waitForFunction((id) => window.agentFeed?.synced(id), id);

test("shows the hint and starts a new chat", async ({ page }) => {
  const state = await chatFixture(page, {
    language: "en",
    history: history({ modelHint: true }),
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "main", assistantId: "home", main: true },
    ],
  });
  await page.route("**/api/assistants/home/chats", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    state.conversations.push({ id: "fresh", assistantId: "home" });
    state.history = history();
    return route.fulfill({ status: 201, json: { id: "fresh", assistantId: "home" } });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await synced(page, "dinner");
  await expect(hint(page)).toContainText(text);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await hint(page).getByRole("button", { name: "New chat" }).click();
  await expect(page).toHaveURL(/\/agents\/home\/chats\/fresh$/);
  await synced(page, "fresh");
  await expect(hint(page)).toHaveCount(0);
});

test("Dismiss puts the hint away", async ({ page }) => {
  const state = await chatFixture(page, {
    language: "en",
    history: history({ modelHint: true }),
  });
  const dismissed = [];
  await page.route(
    "**/api/assistant-conversations/dinner/model-hint-dismissal",
    (route) => {
      dismissed.push(route.request().method());
      state.history = history();
      return route.fulfill({ json: { dismissed: true } });
    },
  );
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await synced(page, "dinner");
  await hint(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(hint(page)).toHaveCount(0);
  expect(dismissed).toEqual(["POST"]);
});
