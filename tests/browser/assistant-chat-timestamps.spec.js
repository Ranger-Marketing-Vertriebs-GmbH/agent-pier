import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

// Fixed local times: today 08:00, yesterday 18:00 and a message from another year.
const today = new Date();
today.setHours(8, 0, 0, 0);
const earlier = new Date();
earlier.setDate(earlier.getDate() - 1);
earlier.setHours(18, 0, 0, 0);
const old = new Date(2020, 5, 15, 9, 30);
const messages = [
  { id: "m1", role: "user", text: "Any news?", timestamp: earlier.getTime() },
  { id: "m2", role: "assistant", text: "Two headlines.", timestamp: earlier.getTime() },
  { id: "m3", role: "user", text: "Thanks.", timestamp: today.getTime() },
  { id: "m4", role: "assistant", text: "Here is today.", timestamp: today.getTime() },
  { id: "m5", role: "assistant", text: "Old reply.", timestamp: old.getTime() },
  { id: "m6", role: "assistant", text: "Legacy reply." },
  {
    id: "m7",
    role: "assistant",
    from: "Studio Lead",
    text: "The lead speaking.",
    timestamp: today.getTime(),
  },
  {
    id: "peer-start:1",
    role: "event",
    event: "peer-request",
    phase: "started",
    type: "question",
    from: "Head Writer",
    to: "Producer",
    timestamp: today.getTime(),
  },
  {
    id: "peer-start:2",
    role: "event",
    event: "peer-request",
    phase: "started",
    type: "task",
    from: "Head Writer",
    to: "Editor",
  },
];

async function setup(page, language, messages) {
  await fixture(page);
  await page.addInitScript((language) => {
    localStorage.setItem("agentpier-language", language);
    const Native = window.EventSource;
    window.EventSource = class {
      constructor(url) {
        if (url !== "/api/assistant-events") return new Native(url);
        window.assistantTestStream = this;
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    };
  }, language);
  const assistant = {
    id: "home",
    name: "Home assistant",
    instructions: "Plan meals",
    model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
    revision: 1,
    effectiveRevision: 1,
  };
  const state = { messages: [...messages], requests: [] };
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
    let body = {};
    if (p === "/api/assistants")
      body = {
        assistants: [assistant],
        conversations: [{ id: "dinner", assistantId: "home" }],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        members: [],
        activity: {},
      };
    else if (p === "/api/assistant-events")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages"))
      body = { messages: state.messages, requests: state.requests, stale: false };
    else if (p === "/api/assistants/home") body = assistant;
    await route.fulfill({ json: body });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.locator(".assistant-message")).toHaveCount(
    messages.filter((m) => m.role !== "event").length,
  );
  return state;
}

const message = (page, text) =>
  page.locator(".assistant-message").filter({ hasText: text });

test("agent and owner messages show their time next to the speaker (English)", async ({
  page,
}) => {
  await setup(page, "en", messages);
  const label = (text) => message(page, text).locator("time");
  await expect(label("Here is today.")).toHaveText("08:00 AM");
  await expect(label("Thanks.")).toHaveText("08:00 AM");
  await expect(label("Two headlines.")).toHaveText(/^[A-Z][a-z]{2},? .+, 06:00 PM$/);
  await expect(label("Old reply.")).toHaveText(/2020.*09:30 AM$/);
  await expect(label("Old reply.")).toHaveAttribute("datetime", old.toISOString());
  await expect(label("Old reply.")).toHaveAttribute("title", /June 15, 2020/);
  // The agent's name stays beside it; the owner's name stays for screen readers.
  await expect(message(page, "Here is today.").locator("strong")).toHaveText(
    "Home assistant",
  );
  await expect(message(page, "Thanks.").locator("strong")).toHaveClass(/sr-only/);
  // No timestamp, no time and no placeholder.
  await expect(message(page, "Legacy reply.").locator("time")).toHaveCount(0);
  await expect(page.locator("time")).toHaveCount(7);
  // A lead's own message in its chat carries the time beside the lead's name.
  await expect(message(page, "The lead speaking.").locator("strong")).toHaveText(
    "Studio Lead",
  );
  await expect(label("The lead speaking.")).toHaveText("08:00 AM");
  // The centred team notice ends with its time; one without a timestamp shows none.
  const notice = (text) => page.locator(".assistant-event").filter({ hasText: text });
  await expect(notice("Head Writer asked Producer a question")).toHaveText(
    "Head Writer asked Producer a question · 08:00 AM",
  );
  await expect(
    notice("Head Writer asked Producer a question").locator("time"),
  ).toHaveAttribute("datetime", today.toISOString());
  await expect(notice("Head Writer gave Editor a task")).toHaveText(
    "Head Writer gave Editor a task",
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the time fits beside the name on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await setup(page, "en", messages);
  await expect(message(page, "Two headlines.").locator("time")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
