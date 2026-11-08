import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { home, setupAssistantSettings } from "../helpers/assistant-settings-browser.js";
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
  note("main-restarted", 6.7),
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
    "The owner restarted the main chat. The previous one is under archived chats.",
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
    "Der Besitzer hat den Hauptchat neu begonnen. Der vorherige ist unter den archivierten Chats.",
    "Gedächtnis nicht gespeichert.",
  ],
};

async function setup(page, language, list = messages) {
  await fixture(page);
  await page.addInitScript((language) => {
    localStorage.setItem("agentpier-language", language);
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
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages"))
      body = { messages: list, requests: [], stale: false };
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
      "main-restarted",
      "something-new",
    ]);
    await expect(log.locator(".assistant-event:not([data-memory-note])")).toHaveText(
      followUp[language],
    );
  });

test("shows the model switch note with both models", async ({ page }) => {
  await setup(page, "en", [
    { id: "q", role: "user", text: "Hello", timestamp: 1 },
    { id: "a", role: "assistant", text: "Hi", timestamp: 1.5 },
    {
      ...note("model-switched", 2),
      details: { from: "GPT-4.1 mini", to: "Claude Sonnet" },
    },
    { ...note("redirected", 3), id: "memory-note:redirected" },
    { ...note("model-switched", 4), id: "memory-note:broken" },
  ]);
  const notes = page.locator("[data-memory-note]");
  await expect(notes).toHaveText([
    "The model changed from GPT-4.1 mini to Claude Sonnet. This chat starts fresh; memory, files and settings stay.",
    "This result was started in the previous chat.",
    "Memory not saved.",
  ]);
});

// Set AGENTPIER_SHOTS_DIR to a directory to keep screenshots of the pins.
const shots = process.env.AGENTPIER_SHOTS_DIR;
const shoot = (name) =>
  shots ? (target) => target.screenshot({ path: `${shots}/${name}.png` }) : () => null;

// A Hermes agent's memory page: its reads name the limits (native-memory.js).
const hermes = (page, extra = {}, memory = {}) =>
  setupAssistantSettings(page, {
    assistants: [
      home({
        name: "Fern",
        runtime: "hermes",
        capabilities: { memory: true, reminders: false },
        ...extra,
      }),
    ],
    memory,
    memoryLimits: { "MEMORY.md": 10000, "USER.md": 5000 },
  });
const entries = (page) => page.getByRole("group", { name: "Entries" });

test("a Hermes agent pins an entry and saves it", async ({ page }) => {
  const state = await hermes(page);
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  await expect(page.getByText(/0 of 10000 characters/)).toBeVisible();
  const notes = page.getByRole("textbox", { name: "Notes" });
  await notes.fill("Owner likes tea\n§\nOwner's vault is /srv/quartz");
  await expect(entries(page).locator(".list-row-label")).toHaveText([
    "Owner likes tea",
    "Owner's vault is /srv/quartz",
  ]);
  await page.getByRole("button", { name: "Pin entry 1" }).click();
  const unpin = page.getByRole("button", { name: "Unpin entry 1" });
  await expect(unpin).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Pin entry 2" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(notes).toHaveValue(/^📌 Owner likes tea\n§\n/);
  await expect(page.getByText("48 of 10000 characters, 17 pinned")).toBeVisible();
  await expect(
    page.getByText("Pinned entries are kept word for word when the agent dreams."),
  ).toBeVisible();
  await shoot("memory-pins")(page);
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0);
  expect(state.memorySaves).toHaveLength(1);
  expect(state.memorySaves[0]).toMatchObject({
    name: "MEMORY.md",
    expectedMissing: true,
  });
  expect(state.memorySaves[0].content.startsWith("📌 ")).toBe(true);
  // The saved file keeps its pins and its limit.
  await expect(unpin).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/48 of 10000 characters/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(unpin).toBeVisible();
  await entries(page).evaluate((element) => element.scrollIntoView({ block: "center" }));
  await shoot("memory-pins-phone")(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("pins are disabled on a user's own agent the owner reads", async ({ page }) => {
  await hermes(
    page,
    { userAccess: { mode: "own" }, ownerReads: true },
    {
      "MEMORY.md": {
        name: "MEMORY.md",
        content: "📌 Owner's vault is /srv/quartz\n§\nOwner likes tea",
        hash: "h1",
      },
    },
  );
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  await expect(page.getByRole("button", { name: "Unpin entry 1" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Pin entry 2" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Notes" })).toHaveAttribute(
    "readonly",
    "",
  );
});

test("a pinned entry the agent replaced shows the new pin after Reload", async ({
  page,
}) => {
  const state = await hermes(
    page,
    {},
    {
      "USER.md": {
        name: "USER.md",
        content: "📌 Owner drinks coffee\n§\nOwner likes jazz",
        hash: "h1",
      },
    },
  );
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  await page.getByRole("combobox", { name: "Note type" }).selectOption("USER.md");
  await expect(page.getByText(/of 5000 characters/)).toBeVisible();
  await expect(entries(page).locator(".list-row-label")).toHaveText([
    "Owner drinks coffee",
    "Owner likes jazz",
  ]);
  // The agent replaced the pinned entry in a chat ("I drink tea now").
  state.memory["USER.md"] = {
    name: "USER.md",
    content: "Owner likes jazz\n§\n📌 Owner drinks tea",
    hash: "h2",
  };
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(entries(page).locator(".list-row-label")).toHaveText([
    "Owner likes jazz",
    "Owner drinks tea",
  ]);
  await expect(page.getByRole("button", { name: "Pin entry 1" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByRole("button", { name: "Unpin entry 2" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("a recorded night re-reads a clean note and keeps an unsaved edit", async ({
  page,
  liveStub,
}) => {
  const state = await hermes(
    page,
    {},
    {
      "MEMORY.md": { name: "MEMORY.md", content: "Owner likes tea", hash: "h1" },
    },
  );
  const night = (modifiedAt) => ({
    files: modifiedAt ? [{ name: "DREAMS.md", diary: true, size: 300, modifiedAt }] : [],
  });
  let listing = night(null);
  await page.route("**/api/assistants/home/memory/files*", (route) =>
    route.fulfill({ json: listing }),
  );
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  await liveStub.waitForSubscribe("agent.memory:home");
  const notes = page.getByRole("textbox", { name: "Notes" });
  await expect(notes).toHaveValue("Owner likes tea");
  await expect(page.getByRole("option", { name: "Dream diary" })).toHaveCount(0);
  // The night rewrote MEMORY.md: the clean note follows it.
  state.memory["MEMORY.md"] = {
    name: "MEMORY.md",
    content: "Owner likes green tea",
    hash: "h2",
  };
  listing = night("2026-11-08T03:05:00Z");
  liveStub.push("agent.memory:home", listing);
  await expect(notes).toHaveValue("Owner likes green tea");
  // An unsaved edit stays through the next night.
  await notes.fill("Owner likes green tea\n§\nOwner reads at night");
  state.memory["MEMORY.md"] = { name: "MEMORY.md", content: "Owner likes", hash: "h3" };
  listing = night("2026-11-09T03:05:00Z");
  listing.files.push({ name: "memory/2026-11-09.md", size: 20 });
  liveStub.push("agent.memory:home", listing);
  // The listing followed the push; the note being edited did not.
  await expect(page.getByRole("option", { name: "memory/2026-11-09.md" })).toHaveCount(1);
  await expect(notes).toHaveValue("Owner likes green tea\n§\nOwner reads at night");
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeVisible();
});
