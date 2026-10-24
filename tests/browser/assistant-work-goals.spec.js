// A work goal in the agent chat (AGENTPIER-208): the open goal with Stop above the
// transcript, and its notes and continuations as quiet lines.
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

const goal = {
  id: "g",
  title: "Review cut",
  done: "The cut is reviewed",
  steps: "",
  state: "open",
  createdAt: 1,
};
const messages = [{ id: "u1", role: "user", text: "Finish the episode", timestamp: 1 }];

test("the open goal shows with Stop and stops through the route", async ({ page }) => {
  const state = await chatFixture(page, {
    history: { messages, requests: [], stale: false, goal },
  });
  const stops = [];
  await page.route("**/goal/stop", (route) => {
    stops.push([route.request().method(), route.request().url()]);
    return route.fulfill({ json: { goal: null } });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const line = page.locator(".assistant-goal-line");
  await expect(page.getByText("Working until done: Review cut")).toBeVisible();
  await expect(line).toHaveAttribute("role", "status");
  await page.waitForFunction(() => window.agentFeed?.sockets.size === 1);
  state.history = { ...state.history, goal: null };
  await line.getByRole("button", { name: "Stop" }).click();
  await expect(line).toHaveCount(0);
  expect(stops).toEqual([
    ["POST", `${baseURL}/api/assistant-conversations/dinner/goal/stop`],
  ]);
});

test("the line hides after a feed push without the goal", async ({ page }) => {
  const state = await chatFixture(page, {
    history: { messages, requests: [], stale: false, goal },
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("Working until done: Review cut")).toBeVisible();
  await page.waitForFunction(() => window.agentFeed?.sockets.size === 1);
  state.history = { ...state.history, goal: null };
  await page.evaluate(() => window.agentFeed.push("dinner"));
  await expect(page.locator(".assistant-goal-line")).toHaveCount(0);
});

test("a failed Stop says so and keeps the line", async ({ page }) => {
  await chatFixture(page, { history: { messages, requests: [], stale: false, goal } });
  await page.route("**/goal/stop", (route) =>
    route.fulfill({ status: 500, json: { error: "Internal" } }),
  );
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const line = page.locator(".assistant-goal-line");
  await expect(line).toBeVisible();
  await line.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("The goal could not be stopped. Try again.")).toBeVisible();
  await expect(line.getByRole("button", { name: "Stop" })).toBeEnabled();
});

test("continuations and goal notes read as quiet lines", async ({ page }) => {
  await chatFixture(page, {
    history: {
      messages: [
        ...messages,
        {
          id: "goal:g:set",
          role: "event",
          event: "goal",
          phase: "set",
          title: "Review cut",
          timestamp: 2,
          runId: null,
        },
        {
          id: "c1",
          role: "event",
          event: "goal-continuation",
          goalTitle: "Review cut",
          timestamp: 3,
          runId: "a2",
        },
        {
          id: "goal:g:blocked",
          role: "event",
          event: "goal",
          phase: "blocked",
          reasonCode: "technical",
          title: "Review cut",
          timestamp: 4,
          runId: null,
        },
        {
          id: "goal:h:done",
          role: "event",
          event: "goal",
          phase: "done",
          title: "Mix",
          text: "All mixed",
          timestamp: 5,
          runId: null,
        },
      ],
      requests: [],
      stale: false,
      goal: null,
    },
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("Continuing · Review cut")).toBeVisible();
  await expect(page.locator('[data-goal-note="set"]')).toHaveText(
    "Working until done: Review cut",
  );
  await expect(
    page.getByText("Goal blocked: Review cut · The model failed several times in a row."),
  ).toBeVisible();
  await expect(page.locator('[data-goal-note="done"]')).toHaveText(
    "Goal done: Mix · All mixed",
  );
  await expect(page.locator("[data-goal-continuation]")).toHaveClass(/assistant-event/);
});
