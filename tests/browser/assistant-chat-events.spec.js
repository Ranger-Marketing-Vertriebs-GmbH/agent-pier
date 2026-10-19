// The agent chat follows its live feed (agent-feed-fake.js stands in for the server's).
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

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

test("a streamed reply shows until the feed brings the stored one", async ({ page }) => {
  const state = await chatFixture(page, { history: running });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("Plan dinner")).toBeVisible();
  await page.waitForFunction(() => window.agentFeed?.sockets.size === 1);
  await page.evaluate(() => {
    window.agentFeed.stream("dinner", "a1", "Dinner");
    window.agentFeed.stream("dinner", "a1", " is", 6);
  });
  const streaming = page.locator(".assistant-message.assistant.streaming");
  await expect(streaming).toHaveText(/Dinner is/);
  state.history = done;
  await page.evaluate(() => window.agentFeed.push("dinner"));
  await expect(reply(page)).toHaveCount(1);
  await expect(streaming).toHaveCount(0);
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

test("list events on the real event stream never read the chat history", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.nativeEventSource = window.EventSource;
  });
  const state = await chatFixture(page, { history: running, conversations: twoChats });
  await page.addInitScript(() => {
    window.EventSource = window.nativeEventSource;
  });
  let reads = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /\/assistant-conversations\/dinner\/messages/.test(request.url())
    )
      reads++;
  });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await page.route("**/api/assistant-events", async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
      body: "retry: 600000\n\n" + 'data: {"type":"change"}\n\n',
    });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("Plan dinner")).toBeVisible();
  await page.waitForTimeout(300);
  const before = reads;
  state.history = done;
  release();
  await page.waitForTimeout(800);
  expect(reads).toBe(before);
  await expect(reply(page)).toHaveCount(0);
  // The feed brings the change.
  await page.evaluate(() => window.agentFeed.push("dinner"));
  await expect(reply(page)).toHaveCount(1, { timeout: 4000 });
});
