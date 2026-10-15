import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

// An owner turn longer than OpenClaw's 8000-character history page default.
const lastLine = "ich glaub ich muss die eh alle migrieren";
const long = `${"x\n".repeat(4500)}${lastLine}`;
const timestamp = Date.now();
const copy = {
  en: { cut: "Shortened: the rest of this message is too long to show." },
  de: { cut: "Gekürzt: Der Rest dieser Nachricht ist zu lang für die Anzeige." },
};

async function setup(page, language = "en") {
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
const owner = (page) => page.locator(".assistant-message.user");

test("a long owner turn shows once while it runs and whole afterwards", async ({
  page,
}) => {
  const state = await setup(page);
  const request = (state) => ({
    id: "request-1",
    clientRequestId: "long",
    text: long,
    state: state === "completed" ? "completed" : "pending",
    createdAt: new Date(timestamp).toISOString(),
    attempt: { id: "attempt-1", state, reviewedAt: null },
  });
  state.requests = [request("accepted")];
  await changed(page);
  await expect(owner(page)).toHaveCount(2);
  // The stored turn names its request: its text no longer has to match.
  state.messages = [
    ...state.messages,
    {
      id: "stored",
      role: "user",
      text: long.slice(0, 8000),
      cut: true,
      requestId: "request-1",
      timestamp,
    },
  ];
  await changed(page);
  await expect(owner(page)).toHaveCount(2);
  await expect(owner(page).last()).not.toContainText(lastLine);
  // Completed, the history serves the whole turn.
  state.requests = [request("completed")];
  state.messages = [
    state.messages[0],
    { id: "stored", role: "user", text: long, requestId: "request-1", timestamp },
  ];
  await changed(page);
  await expect(owner(page)).toHaveCount(2);
  await expect(owner(page).last()).toContainText(lastLine);
  await expect(page.locator(".assistant-message-cut")).toHaveCount(0);
});

for (const language of ["en", "de"]) {
  test(`a message too long to show says it was shortened (${language})`, async ({
    page,
  }) => {
    const state = await setup(page, language);
    state.messages = [
      ...state.messages,
      { id: "huge", role: "assistant", text: "y ".repeat(500), cut: true, timestamp },
    ];
    await changed(page);
    const note = page
      .locator(".assistant-message.assistant")
      .locator(".assistant-message-cut");
    await expect(note).toHaveText(copy[language].cut);
    await expect(page.locator("text=(truncated)")).toHaveCount(0);
  });
}
