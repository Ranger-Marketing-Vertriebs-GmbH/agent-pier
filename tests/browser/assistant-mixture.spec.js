import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// Mixture of Agents of a Hermes agent (ADR 0007, step 7a): Hermes's own group in the
// slot agent.capabilities at the end of the Capabilities tab, in the tab's draft, and
// each advisor's answer as an expandable step of the chat's running turn.
const copy = {
  en: {
    group: "Mixture of Agents",
    add: "Add an advisor model",
    advisor: (n) => `Advisor ${n}`,
    model: "Model",
    modelId: "Model ID",
    remove: (n) => `Remove advisor ${n}`,
    leftOut: "Left out until it is available again: Credentials required",
    kind: "ChatGPT logins and other protocols cannot be advisors yet",
    keyHeader: "This endpoint takes its key in a header of its own",
    receives: "Their providers therefore receive your conversation",
    save: "Save",
    incompleteSave:
      "Choose a connection and a model for every advisor, or remove the advisor, to save.",
    unsaved: "Unsaved changes",
    capabilities: "Capabilities",
    steps: "3 steps",
    done: "Done",
    failed: "Failed",
    status401: "The advisor's provider answered with HTTP status 401.",
    fallback:
      "If this advisor's provider could not serve the request, Hermes answered with the agent's own model instead.",
  },
  de: {
    group: "Mixture of Agents",
    add: "Beratermodell hinzufügen",
    advisor: (n) => `Berater ${n}`,
    model: "Modell",
    modelId: "Modell-ID",
    remove: (n) => `Berater ${n} entfernen`,
    leftOut: "Ausgelassen, bis er wieder verfügbar ist: Zugangsdaten erforderlich",
    kind: "ChatGPT-Anmeldungen und andere Protokolle können noch nicht beraten",
    keyHeader: "Dieser Endpunkt nimmt seinen Schlüssel in einem eigenen Header",
    receives: "Ihre Anbieter erhalten also deine Unterhaltung",
    save: "Speichern",
    incompleteSave:
      "Wähle für jeden Berater einen Zugang und ein Modell oder entferne ihn, um zu speichern.",
    unsaved: "Ungespeicherte Änderungen",
    capabilities: "Fähigkeiten",
    steps: "3 Schritte",
    done: "Erledigt",
    failed: "Fehlgeschlagen",
    status401: "Der Anbieter des Beraters hat mit HTTP-Status 401 geantwortet.",
    fallback:
      "Konnte der Anbieter dieses Beraters die Anfrage nicht bedienen, hat Hermes stattdessen mit dem eigenen Modell des Agenten geantwortet.",
  },
};
const hermesInfo = {
  id: "hermes",
  name: "Hermes Agent",
  version: "0.22.5",
  capabilities: { skills: { available: true, learnsByDefault: true } },
};
const surfaces = [
  { id: "install", slot: "hub.runtime", kind: "built", shows: "always" },
  { id: "mixture", slot: "agent.capabilities", kind: "built", shows: "whileEnabled" },
];
const runtimes = {
  runtimes: [
    { id: "openclaw", name: "OpenClaw", capabilities: {}, surfaces: [], ready: true },
    { ...hermesInfo, surfaces, install: { kind: "optional" }, ready: true },
  ],
};
const heron = {
  id: "home",
  name: "Heron",
  instructions: "",
  revision: 1,
  effectiveRevision: 1,
  runtime: "hermes",
  runtimeInfo: hermesInfo,
  model: { connectionId: "lab", modelId: "m-1" },
  capabilities: { memory: true, reminders: false },
  skillLearning: true,
};
const models = [
  { id: "router", name: "Router", providerId: "openrouter", available: true },
  {
    id: "lab",
    name: "Lab",
    providerId: "endpoint",
    available: true,
    models: [{ modelId: "m-1", label: "Lab One" }],
  },
  {
    id: "off",
    name: "Old key",
    providerId: "openrouter",
    available: false,
    reason: "credentialsRequired",
  },
  {
    id: "azure",
    name: "Azure",
    providerId: "endpoint",
    available: true,
    keyHeader: true,
    models: [{ modelId: "dep" }],
  },
  { id: "openclaw:gpt", name: "ChatGPT", providerId: "openai-chatgpt", available: true },
];
const shots = process.env.AGENTPIER_SCREENSHOT_DIR;

// A stand-in for the server that keeps what a PATCH stores on the profile.
async function setup(page, language, agent = {}) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = { agent: { ...heron, ...agent }, patches: [] };
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
    test("the owner picks advisors and saves them with the tab", async ({
      page,
    }, testInfo) => {
      const state = await setup(page, language);
      await page.goto(settingsPath("capabilities"));
      const mixture = group(page, text.group);
      await expect(mixture).toBeVisible();
      await expect(mixture).toContainText(text.receives);
      await mixture.getByRole("button", { name: text.add }).click();
      const first = mixture.getByRole("combobox", { name: text.advisor(1) });
      // Connections that cannot advise are listed, disabled, with the reason.
      await expect(first.locator("option", { hasText: text.kind })).toBeDisabled();
      await expect(first.locator("option", { hasText: text.keyHeader })).toBeDisabled();
      await first.selectOption("router");
      await mixture.getByRole("textbox", { name: text.modelId }).fill("openai/gpt-x");
      await mixture.getByRole("button", { name: text.add }).click();
      await mixture.getByRole("combobox", { name: text.advisor(2) }).selectOption("lab");
      await mixture.getByRole("combobox", { name: text.model }).selectOption("m-1");
      if (shots) fs.mkdirSync(shots, { recursive: true });
      const name = `runtime-mixture-group-${language}.png`;
      const file = shots ? path.join(shots, name) : testInfo.outputPath(name);
      await mixture.screenshot({ path: file });
      await testInfo.attach(name, { path: file, contentType: "image/png" });
      await saveBar(page, text.unsaved).getByRole("button", { name: text.save }).click();
      await expect.poll(() => state.patches.length).toBe(1);
      expect(state.patches[0]).toEqual({
        runtimeOptions: {
          hermes: {
            mixture: {
              advisors: [
                { connectionId: "router", modelId: "openai/gpt-x" },
                { connectionId: "lab", modelId: "m-1" },
              ],
            },
          },
        },
        revision: 1,
      });
      await expect(saveBar(page, text.unsaved)).toBeHidden();
      // Removing both switches it off.
      await mixture.getByRole("button", { name: text.remove(2) }).click();
      await mixture.getByRole("button", { name: text.remove(1) }).click();
      await saveBar(page, text.unsaved).getByRole("button", { name: text.save }).click();
      await expect.poll(() => state.patches.length).toBe(2);
      expect(state.patches[1]).toEqual({ runtimeOptions: {}, revision: 2 });
    });

    test("a half-filled advisor row keeps the save disabled and says why", async ({
      page,
    }) => {
      const state = await setup(page, language);
      await page.goto(settingsPath("capabilities"));
      const mixture = group(page, text.group);
      await mixture.getByRole("button", { name: text.add }).click();
      const bar = saveBar(page, text.unsaved);
      const save = bar.getByRole("button", { name: text.save });
      await expect(bar).toContainText(text.incompleteSave);
      await expect(save).toBeDisabled();
      await mixture
        .getByRole("combobox", { name: text.advisor(1) })
        .selectOption("router");
      await expect(save).toBeDisabled();
      await mixture.getByRole("textbox", { name: text.modelId }).fill("a/b");
      await expect(save).toBeEnabled();
      await expect(bar).not.toContainText(text.incompleteSave);
      await save.click();
      await expect.poll(() => state.patches.length).toBe(1);
      expect(state.patches[0].runtimeOptions).toEqual({
        hermes: { mixture: { advisors: [{ connectionId: "router", modelId: "a/b" }] } },
      });
    });

    test("an advisor whose connection cannot serve is shown left out", async ({
      page,
    }) => {
      await setup(page, language, {
        runtimeOptions: {
          hermes: { mixture: { advisors: [{ connectionId: "off", modelId: "a/b" }] } },
        },
      });
      await page.goto(settingsPath("capabilities"));
      const mixture = group(page, text.group);
      await expect(mixture).toContainText(text.leftOut);
      await expect(mixture.getByRole("combobox", { name: text.advisor(1) })).toHaveValue(
        "off",
      );
    });

    test("an agent of another runtime has no such group", async ({ page }) => {
      await setup(page, language, {
        runtime: "openclaw",
        runtimeInfo: { id: "openclaw", name: "OpenClaw", capabilities: {} },
      });
      await page.goto(settingsPath("capabilities"));
      await expect(page.getByRole("tab", { name: text.capabilities })).toBeVisible();
      await expect(page.locator("[data-surface=mixture]")).toHaveCount(0);
    });

    test("the chat shows each advisor's answer as an expandable step", async ({
      page,
    }) => {
      await chatFixture(page, {
        language,
        history: {
          messages: [{ id: "q", role: "user", text: "Plan the move.", requestId: "q-1" }],
          requests: [
            {
              id: "q-1",
              state: "running",
              text: "Plan the move.",
              attempt: { id: "a-1", runtimeRunId: "run-1", state: "running" },
            },
          ],
          stale: false,
        },
      });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await page.waitForFunction(() => window.agentFeed?.synced("dinner"));
      await page.evaluate(() =>
        window.agentFeed.send("dinner", {
          type: "steps",
          runId: "run-1",
          steps: [
            {
              id: "advisor:1",
              kind: "advisor",
              advisor: 1,
              model: "openai/gpt-x",
              output: "Book the van first.",
              state: "done",
            },
            {
              id: "advisor:2",
              kind: "advisor",
              advisor: 2,
              model: "m-1",
              output: "",
              failure: "http-401",
              state: "failed",
            },
            { id: "thinking:2", kind: "thinking", state: "done" },
          ],
          omitted: 0,
          phase: "model",
          retry: null,
          quietMs: 0,
        }),
      );
      const details = page.locator(".assistant-run-steps");
      await details.locator("summary").first().click();
      const steps = details.locator(".assistant-run-advisor");
      await expect(steps).toHaveCount(2);
      await expect(steps.nth(0)).toContainText(`${text.advisor(1)} · openai/gpt-x`);
      await expect(steps.nth(0)).toContainText(text.done);
      await expect(steps.nth(1)).toContainText(text.failed);
      const answer = steps.nth(0).getByText("Book the van first.");
      await expect(answer).toBeHidden();
      await steps.nth(0).locator("summary").click();
      await expect(answer).toBeVisible();
      await expect(steps.nth(0)).toContainText(text.fallback);
      // A failed advisor names only its status, translated.
      await steps.nth(1).locator("summary").click();
      await expect(steps.nth(1)).toContainText(text.status401);
      await expect(steps.nth(1)).toContainText(text.fallback);
      await expect(details.locator("summary").first()).toHaveText(text.steps);
    });
  });
