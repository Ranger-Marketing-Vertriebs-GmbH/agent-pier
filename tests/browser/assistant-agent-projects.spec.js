import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

// One agent whose chat holds the three kinds of project note an agent's own projects
// leave (server agent-project-notes.js projectNotes).
async function setup(page, language) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const agent = {
    id: "home",
    name: "Home assistant",
    instructions: "Original",
    model: { connectionId: "router", modelId: "fixture-model" },
    capabilities: { memory: true },
    shell: "approval",
    revision: 1,
    effectiveRevision: 1,
  };
  const note = (id, ago, fields) => ({
    id: `agent-project:${id}`,
    role: "event",
    event: "agent-project",
    projectName: "Shop",
    path: "/work/Shop",
    timestamp: Date.now() - ago,
    runId: null,
    ...fields,
  });
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
        assistants: [agent],
        conversations: [{ id: "chat-1", assistantId: "home" }],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        teams: [],
        members: [],
        policies: {},
        teamSettings: { revision: 1, hostMaxConcurrent: 8 },
      };
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages"))
      body = {
        messages: [
          note("a", 3000, { change: "create", coding: false }),
          note("b", 2000, { change: "create", coding: true }),
          note("c", 1000, { change: "coding", coding: true }),
          note("d", 500, { change: "coding", coding: false }),
        ],
        requests: [],
        stale: false,
      };
    await route.fulfill({ json: body });
  });
}

const notes = (page, change) => page.locator(`[data-agent-project="${change}"]`);

test("an agent's created project shows in its chat", async ({ page }) => {
  await setup(page, "en");
  await page.goto(baseURL + "/agents/home/chats/chat-1");
  await expect(notes(page, "create").first()).toHaveText(
    "Created the project Shop in /work/Shop",
  );
  await expect(notes(page, "create").nth(1)).toHaveText(
    "Created the project Shop in /work/Shop with coding sessions on",
  );
  await expect(notes(page, "coding").first()).toHaveText(
    "Switched coding sessions on for the project Shop",
  );
  await expect(notes(page, "coding").nth(1)).toHaveText(
    "Switched coding sessions off for the project Shop",
  );
});

test("the notes read in German", async ({ page }) => {
  await setup(page, "de");
  await page.goto(baseURL + "/agents/home/chats/chat-1");
  await expect(notes(page, "create").nth(1)).toHaveText(
    "Projekt Shop in /work/Shop angelegt, Coding-Sessions eingeschaltet",
  );
  await expect(notes(page, "coding").first()).toHaveText(
    "Coding-Sessions für das Projekt Shop eingeschaltet",
  );
});
