import { fulfillEnabledAssistantFeature } from "./assistant-browser-fixture.js";
import { fixture } from "../browser/providers-fixture.js";

export function chatAssistant(overrides = {}) {
  return {
    id: "home",
    name: "Home assistant",
    instructions: "Plan meals",
    model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
    revision: 1,
    effectiveRevision: 1,
    ...overrides,
  };
}

// One agent chat with every list field the redesign reads. Options replace the
// defaults; the returned state records posted messages and POST paths. `olderPages`
// maps a `before` cursor to the older history page the chat reads with it.
export async function chatFixture(page, options = {}) {
  const state = {
    language: "en",
    assistants: [chatAssistant()],
    conversations: [{ id: "dinner", assistantId: "home" }],
    models: [{ id: "router", name: "OpenRouter", available: true }],
    members: [],
    teams: [],
    requests: [],
    activity: {},
    actions: [],
    runtime: { availability: "ready", sync: "current" },
    history: {
      messages: [
        { id: "question", role: "user", text: "Help me plan three dinners." },
        { id: "answer", role: "assistant", text: "We can plan dinner together." },
      ],
      requests: [],
      stale: false,
    },
    posted: [],
    calls: [],
    ...options,
  };
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
  }, state.language);
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    if (
      [
        "/api/assistant-channels",
        "/api/assistant-speech",
        "/api/assistant-runtime/updates",
      ].includes(p)
    )
      return route.fallback();
    if (method === "POST") state.calls.push(p);
    let body = {};
    if (p === "/api/assistants")
      body = {
        assistants: state.assistants,
        conversations: state.conversations,
        models: state.models,
        members: state.members,
        teams: state.teams,
        requests: state.requests,
        activity: state.activity,
      };
    else if (p === "/api/assistant-runtime") body = state.runtime;
    else if (p.endsWith("/messages")) {
      if (method === "POST") state.posted.push(route.request().postDataJSON());
      body =
        method === "POST"
          ? {
              request: { id: "sent" },
              attempt: { id: "sent-attempt", state: "accepted" },
            }
          : url.searchParams.has("before")
            ? state.olderPages?.[url.searchParams.get("before")] || {
                messages: [],
                nextBefore: null,
              }
            : state.history;
    } else if (p.endsWith("/actions")) body = { actions: state.actions };
    else if (p.endsWith("/conversations")) {
      const id = p.split("/")[3];
      body = state.conversations.find((c) => c.assistantId === id) || { id: "dinner" };
    } else if (p.startsWith("/api/assistants/"))
      body = state.assistants.find((a) => p === `/api/assistants/${a.id}`) || {};
    await route.fulfill({ json: body });
  });
  return state;
}

// Waits until the page has opened and wired its event stream.
export const emit = async (page, event) => {
  await page.waitForFunction(() => window.assistantTestStream?.onmessage);
  await page.evaluate((event) => {
    window.assistantTestStream.onmessage({ data: JSON.stringify(event) });
  }, event);
};
