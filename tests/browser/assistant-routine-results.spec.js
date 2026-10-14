import fs from "node:fs";
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
  {
    id: "routine",
    role: "assistant",
    text: digest,
    timestamp,
    scheduled: { name: "AI News Update" },
  },
  {
    id: "routine:failed",
    role: "event",
    event: "routine-failed",
    name: "Weekly review",
    timestamp: timestamp + 1,
  },
];
const copy = {
  en: {
    badge: "Scheduled · AI News Update",
    failed: "Routine “Weekly review” could not finish.",
  },
  de: {
    badge: "Geplant · AI News Update",
    failed: "Routine „Weekly review“ konnte nicht abgeschlossen werden.",
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
    else if (p.endsWith("/messages")) body = { messages, requests: [], stale: false };
    else if (p === "/api/assistants/news") body = assistant;
    await route.fulfill({ json: body });
  });
  await page.goto(baseURL + "/agents/news/chats/daily");
  await expect(page.locator(".assistant-message")).toHaveCount(3);
}

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["phone", { width: 390, height: 844 }],
])
  test.describe(name, () => {
    test.use({ viewport, hasTouch: name === "phone", isMobile: name === "phone" });
    for (const language of ["en", "de"])
      test(`a routine's result is badged and a failed run is a quiet line (${language})`, async ({
        page,
      }) => {
        const words = copy[language];
        await setup(page, language);
        const result = page
          .locator(".assistant-message")
          .filter({ hasText: "AI news, October 14" });
        const badge = result.locator(".assistant-scheduled-badge");
        await expect(badge).toHaveText(words.badge);
        await expect(badge).toBeVisible();
        // The badge sits beside the agent's name and is read with it.
        await expect(result.locator(".assistant-message-head > strong")).toHaveText(
          "AI News",
        );
        // Only the routine's result carries it.
        await expect(page.locator(".assistant-scheduled-badge")).toHaveCount(1);
        const failed = page.locator("[data-routine-failed]");
        await expect(failed).toHaveText(words.failed);
        await expect(failed).toHaveClass(/assistant-event/);
        const box = await badge.boundingBox();
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
      });
    test(`routine results screenshot (${name})`, async ({ page }) => {
      const directory = process.env.ROUTINE_RESULT_SHOTS;
      test.skip(!directory, "Screenshots are taken on request.");
      await page.emulateMedia({ colorScheme: "dark" });
      await setup(page, "de");
      fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: `${directory}/routine-result-${name}-de-dark.png` });
    });
  });
