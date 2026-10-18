import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

// A turn whose sessions.send acknowledgement was lost (run-confirmation.js): the chat
// waits calmly while the run may still run, and offers the restart only once quiet.
const copy = {
  en: {
    waiting: "Waiting for the agent service to confirm.",
    status: "Awaiting confirmation",
    recover: "Restart service and acknowledge uncertainty",
  },
  de: {
    waiting: "Bestätigung vom Agenten-Dienst steht aus.",
    status: "Bestätigung ausstehend",
    recover: "Dienst neu starten und Ungewissheit bestätigen",
  },
};
const timestamp = Date.now();

async function setup(page, language) {
  // Time flows normally; the quiet period is skipped with fastForward.
  await page.clock.install();
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
  const state = {
    messages: [{ id: "first", role: "user", text: "Hello", timestamp }],
    requests: [],
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
  await expect(page.locator(".assistant-message")).toHaveCount(1);
  return state;
}
const changed = (page) =>
  page.evaluate(() =>
    window.assistantTestStream.onmessage({ data: JSON.stringify({ type: "change" }) }),
  );
const turn = (attempt, createdAt) => ({
  id: "request-1",
  clientRequestId: "next",
  text: "Let us continue",
  state: attempt.state,
  createdAt,
  attempt: { id: "attempt-1", reviewedAt: null, createdAt, ...attempt },
});

for (const language of ["en", "de"]) {
  test(`an unconfirmed turn waits calmly, then offers the restart (${language})`, async ({
    page,
  }) => {
    const t = copy[language];
    const state = await setup(page, language);
    const recover = page.getByRole("button", { name: t.recover });
    const now = new Date().toISOString();
    state.requests = [turn({ state: "uncertain", unconfirmed: true }, now)];
    await changed(page);
    await expect(page.getByText(t.waiting)).toBeVisible();
    await expect(page.locator(".assistant-run-state")).toHaveText(t.status);
    await expect(recover).toHaveCount(0);
    // Confirmed by the Gateway, it simply runs.
    state.requests = [turn({ state: "running" }, now)];
    await changed(page);
    await expect(page.getByText(t.waiting)).toHaveCount(0);
    await expect(recover).toHaveCount(0);
    // Waiting again, then quiet for longer than the wait (counted from when this chat
    // first saw it waiting): the outcome is unclear and the restart offered.
    state.requests = [turn({ state: "uncertain", unconfirmed: true }, now)];
    await changed(page);
    await expect(page.getByText(t.waiting)).toBeVisible();
    await page.clock.fastForward(125000);
    await expect(recover).toBeVisible();
    await expect(page.getByText(t.waiting)).toHaveCount(0);
  });
}
