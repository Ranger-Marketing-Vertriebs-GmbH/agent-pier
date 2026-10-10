import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
async function setup(page, reminders = []) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = { saved: null, created: null, reminders };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const url = new URL(route.request().url()),
      method = route.request().method();
    const agent = {
      id: "home",
      name: "Home",
      instructions: "Help me",
      model: { connectionId: "router", modelId: "model" },
      revision: 1,
      effectiveRevision: 1,
      capabilities: { memory: true, reminders: true },
    };
    let body = {};
    if (url.pathname === "/api/assistants")
      body = {
        assistants: [agent],
        conversations: [],
        models: [{ id: "router", name: "Router", available: true }],
      };
    else if (url.pathname === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (url.pathname === "/api/assistant-channels") body = { channels: [] };
    else if (url.pathname === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    else if (url.pathname.endsWith("/memory/search"))
      body = {
        results: [
          { path: "memory/network.md", snippet: "The router is in the hallway." },
        ],
      };
    else if (url.pathname.endsWith("/memory/files"))
      body = {
        files: [{ name: "memory/MEMORY.md", size: 14, modifiedAt: "2026-10-10" }],
      };
    else if (url.searchParams.get("name") === "memory/MEMORY.md")
      body = {
        name: "memory/MEMORY.md",
        content: "User likes tea",
        hash: "c".repeat(64),
        missing: false,
        readOnly: true,
      };
    else if (url.pathname.endsWith("/memory")) {
      if (method === "PUT") state.saved = route.request().postDataJSON();
      body = {
        name: "MEMORY.md",
        content: state.saved?.content ?? "Prefers vegetarian meals",
        hash: "a".repeat(64),
        missing: false,
      };
    } else if (url.pathname.endsWith("/reminders")) {
      if (method === "POST") {
        state.created = route.request().postDataJSON();
        state.reminders = [
          {
            id: "reminder",
            name: state.created.name,
            enabled: true,
            revision: 1,
            status: "ready",
            schedule: state.created.schedule,
            deliveryState: "delivered",
          },
        ];
        body = state.reminders[0];
      } else body = { reminders: state.reminders };
    } else if (url.pathname.endsWith("/reminders/reminder/review")) {
      state.reviewed = route.request().postDataJSON();
      state.reminders = [];
      body = { id: "reminder", status: "removed" };
    } else if (url.pathname.endsWith("/reminders/reminder")) {
      if (method === "DELETE") state.reminders = [];
      else state.reminders[0] = { ...state.reminders[0], enabled: false, revision: 2 };
      body = state.reminders[0] || {};
    }
    await route.fulfill({ json: body });
  });
  return state;
}
test("English agent settings edit native memory with its revision and manage daily reminders", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  const memory = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Memory", exact: true }) })
    .last();
  await expect(page.getByLabel("Saved notes")).toHaveValue("Prefers vegetarian meals");
  await page.getByLabel("Saved notes").fill("Prefers quick vegetarian meals");
  await memory.getByRole("button", { name: "Save notes", exact: true }).click();
  await expect.poll(() => state.saved?.expectedHash).toBe("a".repeat(64));
  await page.getByLabel("Search memory").fill("router");
  await memory.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("The router is in the hallway.")).toBeVisible();
  await page.getByLabel("Reminder name").fill("Take a break");
  await page.getByLabel("Reminder text").fill("Stretch for a minute");
  await page.getByLabel("Repeat").selectOption("daily");
  await page.getByLabel("Time", { exact: true }).fill("18:30");
  await page.getByLabel("Timezone", { exact: true }).fill("Europe/Berlin");
  await page.getByRole("button", { name: "Create reminder", exact: true }).click();
  await expect
    .poll(() => state.created?.schedule)
    .toEqual({ kind: "cron", expr: "30 18 * * *", tz: "Europe/Berlin" });
  await page.getByRole("button", { name: "Pause reminder", exact: true }).click();
  await expect(page.getByText("Telegram: Delivered", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume reminder", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: ".cache/assistant-native-settings-en.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resume reminder", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".cache/assistant-native-settings-mobile-en.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Remove reminder", exact: true }).click();
  await expect(page.getByText("No reminders yet.")).toBeVisible();
});
test("English agent settings let the owner review an unconfirmed reminder", async ({
  page,
}) => {
  const state = await setup(page, [
    { id: "reminder", name: "", status: "unknown", enabled: false, reviewRequired: true },
  ]);
  await page.goto(baseURL + "/agents/home/settings");
  await expect(
    page.getByText("It is unclear whether this reminder was created."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Mark as reviewed", exact: true }).click();
  await expect.poll(() => state.reviewed).toEqual({ acknowledgeUnknownOutcome: true });
  await expect(page.getByText("No reminders yet.")).toBeVisible();
});
test("notes the agent wrote under memory/ are shown read-only", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  const memory = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Memory", exact: true }) })
    .last();
  await expect(page.getByLabel("Saved notes")).toHaveValue("Prefers vegetarian meals");
  await page.getByLabel("Note type").selectOption("memory/MEMORY.md");
  await expect(page.getByLabel("Saved notes")).toHaveValue("User likes tea");
  await expect(page.getByLabel("Saved notes")).toHaveAttribute("readonly", "");
  await expect(memory.getByText("The agent writes these notes itself.")).toBeVisible();
  await expect(
    memory.getByRole("button", { name: "Save notes", exact: true }),
  ).toHaveCount(0);
});
