import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { connectedChannel } from "../helpers/assistant-settings-browser.js";
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
    else if (path === "/api/assistant-channels")
      body = { channels: [connectedChannel()] };
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
      // The server keeps the receipt with the routine (its lastEvent).
      body = { ...event, status: state.eventStatus || "unknown" };
      const item = state.routines.find((r) => r.id === path.split("/").at(-2));
      if (item) item.lastEvent = body;
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
  await page.goto(baseURL + settingsPath("routines"));
  const panel = page.getByRole("region", { name: "Routines" });
  await panel.getByRole("button", { name: "+ Routine" }).click();
  await panel.getByLabel("Routine name").fill("Meal plan");
  await panel.getByLabel("Task prompt").fill("Make a vegetarian meal plan.");
  await panel.getByLabel("Routine time", { exact: true }).fill("18:30");
  await panel.getByLabel("Routine timezone").fill("Europe/Berlin");
  // The paired chat is an optional extra; the result always reaches the agent's chat.
  await panel.getByRole("switch", { name: "Also send to Telegram" }).check();
  await panel.getByRole("button", { name: "Create routine" }).click();
  await expect
    .poll(() => state.created?.trigger)
    .toEqual({ kind: "cron", expr: "30 18 * * *", tz: "Europe/Berlin" });
  expect(state.created.telegram).toBe(true);
  await expect(panel.getByText("Daily at 18:30 (Europe/Berlin)")).toBeVisible();
  await panel.getByRole("button", { name: /^Meal plan/ }).click();
  await panel.getByRole("button", { name: "Pause routine" }).click();
  await expect(panel.getByRole("button", { name: "Resume routine" })).toBeVisible();
  await panel.getByRole("button", { name: "Remove routine" }).click();
  // Removing asks first (AGENTPIER-445); Cancel keeps it.
  const dialog = page.getByRole("dialog", { name: "Remove routine “Meal plan”?" });
  await expect(dialog).toContainText("It does not run again.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByRole("button", { name: /^Meal plan/ })).toBeVisible();
  await panel.getByRole("button", { name: "Remove routine" }).click();
  await dialog.getByRole("button", { name: "Remove routine" }).click();
  await expect(panel.getByText("No routines yet.")).toBeVisible();
});
test("event routines distinguish manual and coding events and show unknown delivery without replay", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + settingsPath("routines"));
  const panel = page.getByRole("region", { name: "Routines" });
  await panel.getByRole("button", { name: "+ Routine" }).click();
  await panel.getByLabel("Routine name").fill("Review summary");
  await panel.getByLabel("Task prompt").fill("Summarize what to review next.");
  await panel.getByLabel("Routine trigger").selectOption("event");
  await panel.getByLabel("Routine event").selectOption("coding.completed");
  await panel.getByRole("button", { name: "Create routine" }).click();
  await expect
    .poll(() => state.created?.trigger)
    .toEqual({ kind: "event", eventKind: "coding.completed" });
  expect(state.created).not.toHaveProperty("telegram");
  await panel.getByRole("button", { name: /^Review summary/ }).click();
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
for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["phone", { width: 390, height: 844 }],
]) {
  test(`${label}: a daily routine runs once, and its "Run queued." goes when the run is done`, async ({
    page,
  }) => {
    // AGENTPIER-445: daily routines had no "Run once", and the queued note stayed.
    await page.setViewportSize(viewport);
    const state = await setup(page);
    state.eventStatus = "queued";
    state.routines.push({
      id: "routine-0",
      name: "Daily ping",
      prompt: "Say hello.",
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
      enabled: true,
      revision: 1,
      status: "ready",
    });
    await page.goto(baseURL + settingsPath("routines"));
    const panel = page.getByRole("region", { name: "Routines" });
    await panel.getByRole("button", { name: /^Daily ping/ }).click();
    await panel.getByRole("button", { name: "Run once" }).click();
    await expect(panel.getByText("Run queued.")).toBeVisible();
    expect(state.events).toHaveLength(1);
    await page.screenshot({ path: `.cache/routine-run-once-${label}.png` });
    // The run completed: the server drops the receipt and the list follows.
    delete state.routines[0].lastEvent;
    await panel.getByRole("button", { name: "Pause routine" }).click();
    await expect(panel.getByText("Run queued.")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
  });
}
