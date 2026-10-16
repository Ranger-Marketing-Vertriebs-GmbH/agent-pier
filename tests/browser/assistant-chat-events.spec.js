// The agent chat follows every assistant event and only the newest history read.
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

const running = {
  messages: [{ id: "u1", role: "user", text: "Plan dinner", timestamp: 1 }],
  requests: [
    {
      id: "q1",
      state: "accepted",
      text: "Plan dinner",
      attempt: { id: "a1", state: "running" },
    },
  ],
  stale: false,
};
const done = {
  messages: [
    { id: "u1", role: "user", text: "Plan dinner", timestamp: 1 },
    { id: "m1", role: "assistant", runId: "a1", text: "Dinner is ready.", timestamp: 2 },
  ],
  requests: [
    {
      id: "q1",
      state: "completed",
      text: "Plan dinner",
      attempt: { id: "a1", state: "completed" },
    },
  ],
  stale: false,
};
const twoChats = [
  { id: "dinner", assistantId: "home" },
  { id: "other", assistantId: "home" },
];
const reply = (page) =>
  page.locator(".assistant-message.assistant", { hasText: "Dinner is ready." });

test("a history read that answers late never replaces a newer one", async ({ page }) => {
  const state = await chatFixture(page, { history: running });
  // Each read answers with the state at request time; planned ones wait first.
  const plan = [];
  await page.route(/\/api\/assistant-conversations\/dinner\/messages/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const step = plan.shift();
    if (!step) return route.fulfill({ json: state.history });
    const snapshot = structuredClone(state.history);
    await new Promise((resolve) => setTimeout(resolve, step.delay));
    return route.fulfill({ json: snapshot });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("Plan dinner")).toBeVisible();
  await emit(page, {
    type: "delta",
    conversationId: "dinner",
    runId: "a1",
    text: "Dinner is",
  });
  await expect(page.locator(".assistant-message.assistant.streaming")).toHaveCount(1);
  // The first read still sees the run working and answers slowly.
  plan.push({ delay: 1200 }, { delay: 0 });
  await emit(page, { type: "change" });
  await page.waitForTimeout(150);
  // The run finishes; the second read sees the stored reply and answers at once.
  state.history = done;
  await emit(page, { type: "change" });
  await expect(reply(page)).toHaveCount(1);
  // The first read's answer lands afterwards and is dropped.
  await page.waitForTimeout(1500);
  await expect(reply(page)).toHaveCount(1);
  await expect(page.locator(".assistant-message.assistant.streaming")).toHaveCount(0);
});

test("a change followed at once by another chat's delta still refreshes", async ({
  page,
}) => {
  const state = await chatFixture(page, { history: running, conversations: twoChats });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("Plan dinner")).toBeVisible();
  await page.waitForFunction(() => window.assistantTestStream?.onmessage);
  state.history = done;
  // Two server-sent events from one chunk: two tasks queued back to back.
  await page.evaluate(() => {
    const send = (event) =>
      setTimeout(
        () => window.assistantTestStream.onmessage({ data: JSON.stringify(event) }),
        0,
      );
    send({ type: "change" });
    send({ type: "delta", conversationId: "other", runId: "x", text: "member typing" });
  });
  await expect(reply(page)).toHaveCount(1, { timeout: 4000 });
});

test("a lone change event refreshes the history", async ({ page }) => {
  const state = await chatFixture(page, { history: running });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("Plan dinner")).toBeVisible();
  await page.waitForFunction(() => window.assistantTestStream?.onmessage);
  state.history = done;
  await page.evaluate(() =>
    setTimeout(
      () => window.assistantTestStream.onmessage({ data: '{"type":"change"}' }),
      0,
    ),
  );
  await expect(reply(page)).toHaveCount(1, { timeout: 4000 });
});

test("a real event stream chunk with a change and a delta still refreshes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.nativeEventSource = window.EventSource;
  });
  const state = await chatFixture(page, { history: running, conversations: twoChats });
  await page.addInitScript(() => {
    window.EventSource = window.nativeEventSource;
  });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await page.route("**/api/assistant-events", async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
      body:
        "retry: 600000\n\n" +
        'data: {"type":"change"}\n\n' +
        'data: {"type":"delta","conversationId":"other","runId":"x","text":"typing"}\n\n',
    });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("Plan dinner")).toBeVisible();
  await page.waitForTimeout(300);
  state.history = done;
  release();
  await expect(reply(page)).toHaveCount(1, { timeout: 4000 });
});
