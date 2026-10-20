import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

// Memory an agent could not write, and a write to a shared agent's memory, show as
// quiet lines between the turns
// (server/features/assistants/memory-notes.js).
const note = (reason, timestamp) => ({
  id: `memory-note:${reason}`,
  role: "event",
  event: "memory-note",
  reason,
  timestamp,
  runId: null,
});
const messages = [
  { id: "q", role: "user", text: "Remember: the router is 10.0.0.1.", timestamp: 1 },
  note("guard-pending", 2),
  { id: "a", role: "assistant", text: "I could not save that yet.", timestamp: 3 },
  note("not-owner", 4),
  note("forwarded", 4.1),
  note("automatic", 4.2),
  note("lead-request", 5),
  note("flush", 6),
  note("shared-write", 6.5),
  note("something-new", 7),
  // The agent's follow-up turn after a declined project-knowledge note.
  { id: "followup", role: "event", event: "memory-result", timestamp: 8, runId: null },
];
const followUp = {
  en: "A project knowledge note was not saved. The agent was told.",
  de: "Eine Notiz im Projektwissen wurde nicht gespeichert. Der Agent wurde informiert.",
};
const copy = {
  en: [
    "Memory is read-only for this message: write protection is still starting.",
    "Memory not saved: only your own messages can change memory.",
    "Memory not saved: forwarded content cannot change memory.",
    "Memory not saved: scheduled and automatic turns cannot change memory.",
    "Memory not saved: tasks from the lead agent cannot change memory.",
    "Memory not saved: the automatic note before shortening the conversation was refused.",
    "Applies to everyone who uses this agent.",
    "Memory not saved.",
  ],
  de: [
    "Gedächtnis für diese Nachricht schreibgeschützt: Der Schreibschutz startet noch.",
    "Gedächtnis nicht gespeichert: Nur deine eigenen Nachrichten können das Gedächtnis ändern.",
    "Gedächtnis nicht gespeichert: Weitergeleitete Inhalte können das Gedächtnis nicht ändern.",
    "Gedächtnis nicht gespeichert: Geplante und automatische Durchläufe können das Gedächtnis nicht ändern.",
    "Gedächtnis nicht gespeichert: Aufgaben des leitenden Agenten können das Gedächtnis nicht ändern.",
    "Gedächtnis nicht gespeichert: Die automatische Notiz vor dem Kürzen der Unterhaltung wurde abgelehnt.",
    "Gilt für alle, die diesen Agenten nutzen.",
    "Gedächtnis nicht gespeichert.",
  ],
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
    id: "home",
    name: "Network Architect",
    instructions: "Plan the network",
    model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
    capabilities: { memory: true },
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
        conversations: [{ id: "chat", assistantId: "home" }],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        members: [],
        activity: {},
      };
    else if (p === "/api/assistant-events")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages")) body = { messages, requests: [], stale: false };
    else if (p === "/api/assistants/home") body = assistant;
    await route.fulfill({ json: body });
  });
  await page.goto(baseURL + "/agents/home/chats/chat");
  await expect(page.locator(".assistant-message")).toHaveCount(2);
}

for (const language of ["en", "de"])
  test(`memory that was not saved shows as quiet notes in the chat (${language})`, async ({
    page,
  }) => {
    await setup(page, language);
    const notes = page.locator("[data-memory-note]");
    await expect(notes).toHaveText(copy[language]);
    await expect(notes.first()).toBeVisible();
    await expect(notes.first()).toHaveClass(/assistant-event/);
    // Each note sits where it happened: the read-only turn note before the reply.
    const log = page.getByRole("log");
    const order = await log
      .locator(".assistant-message, [data-memory-note]")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-memory-note") || "message"),
      );
    expect(order).toEqual([
      "message",
      "guard-pending",
      "message",
      "not-owner",
      "forwarded",
      "automatic",
      "lead-request",
      "flush",
      "shared-write",
      "something-new",
    ]);
    await expect(log.locator(".assistant-event:not([data-memory-note])")).toHaveText(
      followUp[language],
    );
  });
