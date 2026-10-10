import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
async function setup(page) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = { routines: [], created: null, events: [] };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    let body = {};
    if (path === "/api/assistants")
      body = {
        assistants: [
          {
            id: "home",
            name: "Home",
            instructions: "Help",
            model: { connectionId: "router", modelId: "model" },
            revision: 1,
            capabilities: { reminders: true, memory: false },
          },
        ],
        conversations: [],
        models: [{ id: "router", name: "Router", available: true }],
      };
    else if (path === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    else if (path.endsWith("/routines")) {
      if (method === "POST") {
        state.created = route.request().postDataJSON();
        const item = {
          ...state.created,
          id: `routine-${state.routines.length}`,
          enabled: true,
          revision: 1,
          status: "ready",
        };
        state.routines.push(item);
        body = item;
      } else body = { routines: state.routines };
    } else if (path.includes("/routines/") && path.endsWith("/events")) {
      const event = route.request().postDataJSON();
      state.events.push(event);
      body = { ...event, status: "unknown" };
    } else if (path.includes("/routines/")) {
      const id = path.split("/").at(-1),
        item = state.routines.find((r) => r.id === id);
      if (method === "DELETE") state.routines = state.routines.filter((r) => r.id !== id);
      else
        Object.assign(item, route.request().postDataJSON(), {
          revision: item.revision + 1,
        });
      body = item || {};
    }
    await route.fulfill({ json: body });
  });
  return state;
}
test("English routines create a daily prompt, pause and remove it", async ({ page }) => {
  const state = await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  const panel = page.getByRole("region", { name: "Routines" });
  await panel.getByLabel("Routine name").fill("Meal plan");
  await panel.getByLabel("Task prompt").fill("Make a vegetarian meal plan.");
  await panel.getByLabel("Routine time", { exact: true }).fill("18:30");
  await panel.getByLabel("Routine timezone").fill("Europe/Berlin");
  await panel.getByRole("button", { name: "Create routine" }).click();
  await expect
    .poll(() => state.created?.trigger)
    .toEqual({ kind: "cron", expr: "30 18 * * *", tz: "Europe/Berlin" });
  await expect(panel.getByText("Daily at 18:30 (Europe/Berlin)")).toBeVisible();
  await panel.getByRole("button", { name: "Pause routine" }).click();
  await expect(panel.getByRole("button", { name: "Resume routine" })).toBeVisible();
  await panel.getByRole("button", { name: "Remove routine" }).click();
  await expect(panel.getByText("No routines yet.")).toBeVisible();
});
test("event routines distinguish manual and coding events and show unknown delivery without replay", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  const panel = page.getByRole("region", { name: "Routines" });
  await panel.getByLabel("Routine name").fill("Review summary");
  await panel.getByLabel("Task prompt").fill("Summarize what to review next.");
  await panel.getByLabel("Routine trigger").selectOption("event");
  await panel.getByLabel("Routine event").selectOption("coding.completed");
  await panel.getByRole("button", { name: "Create routine" }).click();
  await expect
    .poll(() => state.created?.trigger)
    .toEqual({ kind: "event", eventKind: "coding.completed" });
  await panel.getByRole("button", { name: "Run once" }).click();
  await expect(
    panel.getByText(
      "Start outcome unknown. This event will not be retried automatically.",
    ),
  ).toBeVisible();
  expect(state.events).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
