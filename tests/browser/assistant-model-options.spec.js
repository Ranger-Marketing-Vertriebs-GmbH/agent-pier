import { test, expect } from "../helpers/browser-test.js";
import { fixture } from "./providers-fixture.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";

// How an OpenClaw agent's model works: OpenClaw's group below the model on the
// agent's Identity tab (slot agent.identity), in the tab's draft and saved with its
// PATCH. Loop protection is one switch whose default follows the model's connection.
// A temporary team member shows that it follows its lead; a Hermes agent has no such
// group.
const copy = {
  en: {
    group: "Model behaviour",
    loop: "Loop protection",
    thinking: "Thinking level",
    fast: "Fast mode",
    inherit: "Default",
    high: "High",
    on: "On",
    member: "Follows the lead",
    save: "Save",
    unsaved: "Unsaved changes",
    model: "Model",
  },
  de: {
    group: "Modellverhalten",
    loop: "Schleifenschutz",
    thinking: "Denkstufe",
    fast: "Schnellmodus",
    inherit: "Standard",
    high: "Hoch",
    on: "An",
    member: "Folgt dem leitenden Agenten",
    save: "Speichern",
    unsaved: "Ungespeicherte Änderungen",
    model: "Modell",
  },
};
const info = (id, name) => ({ id, name, version: "2026.11.6", capabilities: {} });
const built = (id, slot) => ({ id, slot, kind: "built", shows: "whileEnabled" });
const runtimes = {
  runtimes: [
    {
      ...info("openclaw", "OpenClaw"),
      surfaces: [
        built("modelOptions", "agent.identity"),
        built("memoryWiki", "agent.capabilities"),
      ],
      install: { kind: "builtin" },
      ready: true,
    },
    {
      ...info("hermes", "Hermes Agent"),
      surfaces: [built("mixture", "agent.capabilities")],
      install: { kind: "optional" },
      ready: true,
    },
  ],
};
const owl = {
  id: "home",
  name: "Owl",
  instructions: "",
  revision: 1,
  effectiveRevision: 1,
  runtime: "openclaw",
  runtimeInfo: info("openclaw", "OpenClaw"),
  model: { connectionId: "router", modelId: "a/b" },
  capabilities: { memory: true, reminders: false },
  // Switched on in the Capabilities tab: a save from Identity must keep it.
  runtimeOptions: { openclaw: { memoryWiki: true } },
};
const models = [
  { id: "router", name: "Router", providerId: "openrouter", available: true },
  // The owner's own endpoint: its models are protected against loops by default.
  {
    id: "local",
    name: "Local",
    providerId: "endpoint",
    available: true,
    models: [{ modelId: "small", name: "small" }],
  },
];

// A stand-in for the server that keeps what a PATCH stores on the profile.
async function setup(page, language, agent = {}) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = { agent: { ...owl, ...agent }, patches: [] };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/assistant-runtimes") return route.fulfill({ json: runtimes });
    if (pathname === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      state.patches.push(body);
      state.agent = { ...state.agent, ...body, revision: state.agent.revision + 1 };
      return route.fulfill({ json: { ...state.agent, pending: false } });
    }
    if (pathname === "/api/assistants")
      return route.fulfill({
        json: { assistants: [state.agent], conversations: [], models },
      });
    if (pathname === "/api/assistant-runtime")
      return route.fulfill({
        json: { availability: "ready", sync: "current", browser: { available: true } },
      });
    return route.fulfill({ json: {} });
  });
  return state;
}
const group = (page, name) => page.getByRole("region", { name, exact: true });

for (const [language, text] of Object.entries(copy))
  test.describe(language, () => {
    test("the owner sets the thinking level and fast mode below the model", async ({
      page,
    }) => {
      const state = await setup(page, language);
      await page.goto(settingsPath("identity"));
      const controls = group(page, text.group);
      await expect(controls).toBeVisible();
      const thinking = controls.getByRole("combobox", { name: text.thinking });
      const fast = controls.getByRole("combobox", { name: text.fast });
      // Unset: both follow the default.
      await expect(thinking).toHaveValue("");
      await expect(fast).toHaveValue("");
      await expect(thinking.locator("option")).toHaveCount(10);
      await thinking.selectOption({ label: text.high });
      await fast.selectOption({ label: text.on });
      await saveBar(page, text.unsaved).getByRole("button", { name: text.save }).click();
      await expect.poll(() => state.patches.length).toBe(1);
      expect(state.patches[0]).toEqual({
        name: "Owl",
        instructions: "",
        model: { connectionId: "router", modelId: "a/b" },
        runtimeOptions: {
          openclaw: { memoryWiki: true, thinking: "high", fastMode: true },
        },
        revision: 1,
      });
      await expect(saveBar(page, text.unsaved)).toHaveCount(0);
      await expect(thinking).toHaveValue("high");
      // Back to the default stores nothing for that setting.
      await thinking.selectOption({ label: text.inherit });
      await saveBar(page, text.unsaved).getByRole("button", { name: text.save }).click();
      await expect.poll(() => state.patches.length).toBe(2);
      expect(state.patches[1].runtimeOptions).toEqual({
        openclaw: { memoryWiki: true, fastMode: true },
      });
    });

    test("loop protection follows the model until the owner flips it", async ({
      page,
    }) => {
      const state = await setup(page, language);
      await page.goto(settingsPath("identity"));
      const loop = group(page, text.group).getByRole("switch", { name: text.loop });
      // An OpenRouter model: off unless the owner switches it on, which is stored.
      await expect(loop).not.toBeChecked();
      await loop.check();
      await saveBar(page, text.unsaved).getByRole("button", { name: text.save }).click();
      await expect.poll(() => state.patches.length).toBe(1);
      expect(state.patches[0].runtimeOptions).toEqual({
        openclaw: { memoryWiki: true, loopDetection: true },
      });
      await expect(loop).toBeChecked();
      // Back to what the model's rule says anyway: nothing is stored for it.
      await loop.uncheck();
      await saveBar(page, text.unsaved).getByRole("button", { name: text.save }).click();
      await expect.poll(() => state.patches.length).toBe(2);
      expect(state.patches[1].runtimeOptions).toEqual({ openclaw: { memoryWiki: true } });
    });

    test("a model of the owner's own endpoint is protected by default", async ({
      page,
    }) => {
      const state = await setup(page, language, {
        model: { connectionId: "local", modelId: "small" },
        runtimeOptions: undefined,
      });
      await page.goto(settingsPath("identity"));
      const loop = group(page, text.group).getByRole("switch", { name: text.loop });
      await expect(loop).toBeChecked();
      await expect(saveBar(page, text.unsaved)).toHaveCount(0);
      // Switching it off is a choice against the rule, stored as such.
      await loop.uncheck();
      await saveBar(page, text.unsaved).getByRole("button", { name: text.save }).click();
      await expect.poll(() => state.patches.length).toBe(1);
      expect(state.patches[0].runtimeOptions).toEqual({
        openclaw: { loopDetection: false },
      });
      await expect(loop).not.toBeChecked();
    });

    test("a temporary member shows that it follows its lead", async ({ page }) => {
      await setup(page, language, {
        teamMemberId: "tm-1",
        lifetime: "task",
        parentAssistantId: "lead",
        runtimeOptions: undefined,
      });
      await page.goto(settingsPath("identity"));
      const controls = group(page, text.group);
      await expect(controls).toContainText(text.member);
      await expect(controls.getByRole("combobox")).toHaveCount(0);
      await expect(controls.getByRole("switch")).toHaveCount(0);
    });

    test("a Hermes agent has no such group", async ({ page }) => {
      await setup(page, language, {
        runtime: "hermes",
        runtimeInfo: info("hermes", "Hermes Agent"),
        runtimeOptions: undefined,
      });
      await page.goto(settingsPath("identity"));
      await expect(page.getByRole("textbox").first()).toHaveValue("Owl");
      await expect(group(page, text.group)).toHaveCount(0);
    });
  });
