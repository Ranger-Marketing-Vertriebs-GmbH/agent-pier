import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

const at = new Date();
at.setHours(9, 0, 0, 0);
const timestamp = at.getTime();
const digest = [
  "**AI news, October 14**",
  "",
  "- OpenClaw 2026.10 ships scheduled tool caps.",
  "- A new open-weights model tops the coding benchmarks.",
  "- Two labs publish a joint evaluation of agent safety.",
].join("\n");
const messages = [
  { id: "q", role: "user", text: "Send me the AI news every morning.", timestamp: 1 },
  { id: "a", role: "assistant", text: "Done: a daily routine at 9:00.", timestamp: 2 },
];
// Routine results leave the transcript for the chat's event area (agent-event-area.js).
const events = [
  {
    id: "routine:failed",
    source: "routine",
    name: "Weekly review",
    at: timestamp + 1,
    status: "failed",
    firstLine: "",
  },
  {
    id: "routine:digest",
    source: "routine",
    name: "AI News Update",
    at: timestamp,
    status: "done",
    firstLine: "**AI news, October 14**",
    reply: digest,
  },
];
const copy = {
  en: {
    group: "Events",
    done: "Done",
    failed: "Failed",
    run: "The run could not finish.",
  },
  de: {
    group: "Ereignisse",
    done: "Fertig",
    failed: "Fehlgeschlagen",
    run: "Der Lauf konnte nicht abgeschlossen werden.",
  },
};

async function setup(page, language) {
  await fixture(page);
  await page.addInitScript((language) => {
    localStorage.setItem("agentpier-language", language);
    const Native = window.EventSource;
    window.EventSource = class {
      constructor(url) {
        if (url !== "/api/assistant-events") return new Native(url);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    };
  }, language);
  const assistant = {
    id: "news",
    name: "AI News",
    instructions: "Collect news",
    model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
    revision: 1,
    effectiveRevision: 1,
  };
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
        conversations: [{ id: "daily", assistantId: "news" }],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        members: [],
        activity: {},
      };
    else if (p === "/api/assistant-events")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages"))
      body = { messages, requests: [], events, stale: false };
    else if (p === "/api/assistants/news") body = assistant;
    await route.fulfill({ json: body });
  });
  await page.goto(baseURL + "/agents/news/chats/daily");
  await expect(page.locator(".assistant-message")).toHaveCount(2);
}

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["phone", { width: 390, height: 844 }],
])
  test.describe(name, () => {
    test.use({ viewport, hasTouch: name === "phone", isMobile: name === "phone" });
    for (const language of ["en", "de"])
      test(`a routine's result and a failed run wait in the Events group (${language})`, async ({
        page,
      }) => {
        const words = copy[language];
        await setup(page, language);
        // Neither is a message, and no result carries a "Scheduled" badge any more.
        await expect(page.locator(".assistant-transcript")).not.toContainText(
          "October 14",
        );
        await expect(page.locator(".assistant-scheduled-badge")).toHaveCount(0);
        const head = page.locator(".agent-event-group > .activity-row-head");
        await expect(head.locator(".activity-row-label")).toHaveText(words.group);
        await head.click();
        const rows = page.locator(".agent-event-row");
        await expect(rows).toHaveCount(2);
        const result = rows.filter({ hasText: "AI News Update" });
        await expect(result.locator(".status-chip")).toHaveText(words.done);
        await expect(result.locator(".activity-row-detail")).toHaveText(
          "**AI news, October 14**",
        );
        await result.locator(".activity-row-head").click();
        // The full reply renders as the agent's Markdown.
        await expect(result.locator(".agent-event-reply strong")).toHaveText(
          "AI news, October 14",
        );
        await expect(result.locator(".agent-event-reply li")).toHaveCount(3);
        const failed = rows.filter({ hasText: "Weekly review" });
        await expect(failed.locator(".status-chip")).toHaveText(words.failed);
        await failed.locator(".activity-row-head").click();
        await expect(failed.locator(".activity-row-body")).toContainText(words.run);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
      });
    test(`routine results screenshot (${name})`, async ({ page }, info) => {
      test.skip(!process.env.ROUTINE_RESULT_SHOTS, "Screenshots are taken on request.");
      await page.emulateMedia({ colorScheme: "dark" });
      await setup(page, "de");
      await page.locator(".agent-event-group > .activity-row-head").click();
      await page.screenshot({
        path: info.outputPath(`routine-result-${name}-de-dark.png`),
      });
    });
  });
