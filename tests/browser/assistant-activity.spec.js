import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

const home = {
  id: "home",
  name: "Home assistant",
  instructions: "Plan meals",
  model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
  revision: 1,
  effectiveRevision: 1,
};

// Serves one agent chat. `list` is merged into the /api/assistants body, so a test can
// drop or replace `activity` to imitate older or partial server responses.
async function activityFixture(page, list = {}) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname;
    if (
      [
        "/api/assistant-channels",
        "/api/assistant-speech",
        "/api/assistant-runtime/updates",
      ].includes(p)
    )
      return route.fallback();
    if (p === "/api/assistant-events")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    let body = {};
    if (p === "/api/assistants")
      body = {
        assistants: [home],
        conversations: [{ id: "dinner", assistantId: "home" }],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        ...list,
      };
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages")) body = { messages: [], requests: [], stale: false };
    else if (p.endsWith("/conversations")) body = { id: "dinner", assistantId: "home" };
    else if (p === "/api/assistants/home") body = home;
    await route.fulfill({ json: body });
  });
}

for (const [name, list] of [
  ["without an activity map", {}],
  [
    "with an activity map that lacks the agent",
    { activity: { other: { state: "working" } } },
  ],
])
  test(`agent chat and sidebar render idle ${name}`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await activityFixture(page, list);
    await page.goto(baseURL + "/agents/home/chats/dinner");
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
    await expect(page.locator(".assistant-sidebar-item").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
