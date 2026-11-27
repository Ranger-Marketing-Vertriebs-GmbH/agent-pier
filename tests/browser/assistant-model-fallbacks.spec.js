import { test, expect } from "../helpers/browser-test.js";
import { fixture } from "./providers-fixture.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";

// The fallback models of an OpenClaw agent: rows of OpenClaw's "Model behaviour"
// group below the model on the agent's Identity tab, in the tab's draft and saved
// with its PATCH (runtimeOptions.openclaw.fallbacks). Up to two, in order, each a
// model of an OpenRouter or endpoint connection; a ChatGPT login is not offered.
const copy = {
  en: {
    group: "Model behaviour",
    label: "Fallback models",
    none: "None",
    add: "Add a fallback model",
    connection: (n) => `Fallback ${n}: connection`,
    model: (n) => `Fallback ${n}: model`,
    modelId: (n) => `Fallback ${n}: model ID`,
    remove: (n) => `Remove fallback ${n}`,
    incomplete: "Choose a connection and a model.",
    incompleteSave:
      "Choose a connection and a model for every fallback model, or remove it, to save.",
    twiceSave: "Each fallback model must be a different model.",
    ownModel: "This is the agent's own model. Choose another one.",
    leftOut: "Left out until it is available again: This connection no longer exists",
    member: "Follows the lead",
    save: "Save",
    unsaved: "Unsaved changes",
  },
  de: {
    group: "Modellverhalten",
    label: "Ersatzmodelle",
    none: "Keine",
    add: "Ersatzmodell hinzufügen",
    connection: (n) => `Ersatzmodell ${n}: Zugang`,
    model: (n) => `Ersatzmodell ${n}: Modell`,
    modelId: (n) => `Ersatzmodell ${n}: Modell-ID`,
    remove: (n) => `Ersatzmodell ${n} entfernen`,
    incomplete: "Wähle einen Zugang und ein Modell.",
    incompleteSave:
      "Wähle für jedes Ersatzmodell einen Zugang und ein Modell oder entferne es, um zu speichern.",
    twiceSave: "Jedes Ersatzmodell muss ein anderes Modell sein.",
    ownModel: "Das ist das eigene Modell des Agenten. Wähle ein anderes.",
    leftOut: "Ausgelassen, bis es wieder verfügbar ist: Diesen Zugang gibt es nicht mehr",
    member: "Folgt dem leitenden Agenten",
    save: "Speichern",
    unsaved: "Ungespeicherte Änderungen",
  },
};
const info = (id, name) => ({ id, name, version: "2026.11.6", capabilities: {} });
const built = (id, slot) => ({ id, slot, kind: "built", shows: "whileEnabled" });
const runtimes = {
  runtimes: [
    {
      ...info("openclaw", "OpenClaw"),
      surfaces: [built("modelOptions", "agent.identity")],
      install: { kind: "builtin" },
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
  // Set in the same group: a change of the fallbacks must keep it.
  runtimeOptions: { openclaw: { thinking: "high" } },
};
const models = [
  { id: "router", name: "Router", providerId: "openrouter", available: true },
  {
    id: "local",
    name: "Local",
    providerId: "endpoint",
    available: true,
    models: [{ modelId: "small", name: "small" }],
  },
  {
    id: "openclaw:account",
    name: "Work account",
    providerId: "openai-chatgpt",
    available: true,
    models: [{ modelId: "gpt-x" }],
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
const save = (page, text) =>
  saveBar(page, text.unsaved).getByRole("button", { name: text.save });

for (const [language, text] of Object.entries(copy))
  test.describe(language, () => {
    test("the owner adds two fallback models in order and removes one", async ({
      page,
    }) => {
      const state = await setup(page, language);
      await page.goto(settingsPath("identity"));
      const controls = group(page, text.group);
      await expect(controls).toContainText(text.label);
      await expect(controls).toContainText(text.none);
      await controls.getByRole("button", { name: text.add }).click();
      // A new row cannot be saved until it names a connection and a model.
      await expect(controls).toContainText(text.incomplete);
      await expect(save(page, text)).toBeDisabled();
      await expect(saveBar(page, text.unsaved)).toContainText(text.incompleteSave);
      const first = controls.getByRole("combobox", { name: text.connection(1) });
      // A ChatGPT login is not among the choices.
      await expect(first.locator("option")).toHaveCount(3);
      await expect(first.locator("option", { hasText: "Work account" })).toHaveCount(0);
      // An endpoint lists its models; OpenRouter takes a model ID.
      await first.selectOption("local");
      await controls.getByRole("combobox", { name: text.model(1) }).selectOption("small");
      await controls.getByRole("button", { name: text.add }).click();
      await controls
        .getByRole("combobox", { name: text.connection(2) })
        .selectOption("router");
      const modelId = controls.getByRole("textbox", { name: text.modelId(2) });
      // The agent's own model cannot be its own fallback.
      await modelId.fill("a/b");
      await expect(controls).toContainText(text.ownModel);
      await modelId.fill("vendor/small");
      await expect(controls).not.toContainText(text.ownModel);
      // Two at most.
      await expect(controls.getByRole("button", { name: text.add })).toHaveCount(0);
      await expect(save(page, text)).toBeEnabled();
      await save(page, text).click();
      await expect.poll(() => state.patches.length).toBe(1);
      expect(state.patches[0].runtimeOptions).toEqual({
        openclaw: {
          thinking: "high",
          fallbacks: [
            { connectionId: "local", modelId: "small" },
            { connectionId: "router", modelId: "vendor/small" },
          ],
        },
      });
      await expect(saveBar(page, text.unsaved)).toHaveCount(0);
      // Removing the first one leaves the second as the only fallback.
      await controls.getByRole("button", { name: text.remove(1) }).click();
      await expect(
        controls.getByRole("combobox", { name: text.connection(1) }),
      ).toHaveValue("router");
      await save(page, text).click();
      await expect.poll(() => state.patches.length).toBe(2);
      expect(state.patches[1].runtimeOptions).toEqual({
        openclaw: {
          thinking: "high",
          fallbacks: [{ connectionId: "router", modelId: "vendor/small" }],
        },
      });
      // Removing the last one stores no fallbacks and keeps the other options.
      await controls.getByRole("button", { name: text.remove(1) }).click();
      await save(page, text).click();
      await expect.poll(() => state.patches.length).toBe(3);
      expect(state.patches[2].runtimeOptions).toEqual({ openclaw: { thinking: "high" } });
      await expect(controls).toContainText(text.none);
    });

    test("the same model twice cannot be saved", async ({ page }) => {
      await setup(page, language, {
        runtimeOptions: {
          openclaw: { fallbacks: [{ connectionId: "local", modelId: "small" }] },
        },
      });
      await page.goto(settingsPath("identity"));
      const controls = group(page, text.group);
      await controls.getByRole("button", { name: text.add }).click();
      await controls
        .getByRole("combobox", { name: text.connection(2) })
        .selectOption("local");
      await controls.getByRole("combobox", { name: text.model(2) }).selectOption("small");
      await expect(save(page, text)).toBeDisabled();
      await expect(saveBar(page, text.unsaved)).toContainText(text.twiceSave);
    });

    test("a fallback whose connection is gone stays listed as left out", async ({
      page,
    }) => {
      await setup(page, language, {
        runtimeOptions: {
          openclaw: { fallbacks: [{ connectionId: "deleted", modelId: "m" }] },
        },
      });
      await page.goto(settingsPath("identity"));
      const controls = group(page, text.group);
      await expect(controls).toContainText(text.leftOut);
      await expect(
        controls.getByRole("combobox", { name: text.connection(1) }),
      ).toHaveValue("deleted");
      // Nothing to save: the agent runs on its own model until it is back or removed.
      await expect(saveBar(page, text.unsaved)).toHaveCount(0);
    });

    test("a temporary member has no fallback rows of its own", async ({ page }) => {
      await setup(page, language, {
        teamMemberId: "tm-1",
        lifetime: "task",
        parentAssistantId: "lead",
        runtimeOptions: undefined,
      });
      await page.goto(settingsPath("identity"));
      const controls = group(page, text.group);
      await expect(controls).toContainText(text.member);
      await expect(controls.getByRole("button", { name: text.add })).toHaveCount(0);
    });
  });
