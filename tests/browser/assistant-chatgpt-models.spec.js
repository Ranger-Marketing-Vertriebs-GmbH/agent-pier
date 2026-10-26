import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { wizardFinish, wizardToIdentity } from "../helpers/agent-wizard-browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
import {
  emitChange,
  setupAssistantSettings,
} from "../helpers/assistant-settings-browser.js";

const listed = [
  { modelId: "gpt-6-astra", label: "GPT-6 Astra" },
  { modelId: "gpt-6-sol", label: "GPT-6 Sol" },
  { modelId: "gpt-5.5", label: "GPT-5.5" },
];
// Screenshots for review only; never part of the repository.
const shots = process.env.AGENTPIER_CHATGPT_MODEL_SHOTS;

async function setup(page, { language = "en", models = listed, modelCatalog } = {}) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = {
    account: {
      id: "openclaw:test",
      name: "Personal ChatGPT",
      providerId: "openai-chatgpt",
      status: "ok",
      available: true,
      models,
      modelCatalog: modelCatalog || (models.length ? "ready" : "failed"),
    },
    refreshes: 0,
    refreshAnswer: null,
    saved: null,
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === "/api/assistant-model-accounts/openclaw%3Atest/models/refresh") {
      state.refreshes++;
      const answer = await (state.refreshAnswer?.() ?? null);
      if (answer?.status) return route.fulfill({ status: answer.status, json: {} });
      if (answer) Object.assign(state.account, answer);
      const { models: current, modelCatalog: catalog } = state.account;
      return route.fulfill({ json: { models: current, modelCatalog: catalog } });
    }
    if (pathname === "/api/assistant-model-accounts")
      return route.fulfill({ json: { accounts: [state.account] } });
    if (pathname === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready" } });
    if (pathname === "/api/assistants" && method === "POST") {
      state.saved = route.request().postDataJSON();
      return route.fulfill({ json: { ...state.saved, id: "new", revision: 1 } });
    }
    // A created agent opens its first chat.
    if (pathname === "/api/assistants/new/conversations" && method === "POST")
      return route.fulfill({ json: { id: "new-chat", assistantId: "new" } });
    if (pathname === "/api/assistants")
      return route.fulfill({
        json: { assistants: [], conversations: [], models: [state.account] },
      });
    return route.fallback();
  });
  return state;
}

async function newAgent(page, copy) {
  await page.goto(baseURL + "/agents");
  await page.getByRole("link", { name: copy.create }).click();
  await wizardToIdentity(page, copy.language);
  await page.getByLabel("Name", { exact: true }).fill("Home");
  await page.getByLabel(copy.connection).selectOption("openclaw:test");
}

const english = {
  language: "en",
  create: "New agent",
  connection: "Model connection",
  model: "Model",
  modelId: "Model ID",
  choose: "Choose a model",
  options: "options",
  custom: "Custom model ID …",
  search: "Search models",
  refresh: "Refresh models",
  loading: "Loading ChatGPT models …",
  failed:
    "The ChatGPT model list could not be loaded. Enter a model ID or try again later.",
  stale:
    "The ChatGPT model list could not be refreshed and may be out of date. A custom model ID stays possible.",
  unknown:
    "The Gateway checked this list with another ChatGPT account. Some models may not work with this one.",
  createAgent: "Create agent",
  save: "Save agent",
};
const german = {
  language: "de",
  create: "Neuer Agent",
  connection: "Provider-Zugang",
  model: "Modell",
  modelId: "Modell-ID",
  choose: "Modell auswählen",
  options: "Optionen",
  custom: "Eigene Modell-ID …",
  search: "Modelle suchen",
  refresh: "Modelle aktualisieren",
  loading: "ChatGPT-Modelle werden geladen …",
  failed:
    "Die ChatGPT-Modellliste konnte nicht geladen werden. Gib eine Modell-ID ein oder versuche es später erneut.",
  stale:
    "Die ChatGPT-Modellliste konnte nicht aktualisiert werden und ist eventuell veraltet. Eine eigene Modell-ID bleibt möglich.",
  unknown:
    "Das Gateway hat diese Liste mit einem anderen ChatGPT-Konto geprüft. Manche Modelle funktionieren mit diesem Konto eventuell nicht.",
  createAgent: "Agent anlegen",
  save: "Agent speichern",
};

for (const [language, copy] of [
  ["en", english],
  ["de", german],
]) {
  test(`${language}: a ChatGPT account lists its models and saves the chosen one`, async ({
    page,
  }) => {
    const state = await setup(page, { language });
    await newAgent(page, copy);
    const model = page.getByRole("combobox", { name: copy.model, exact: true });
    await expect(model).toHaveValue("");
    await expect(model.locator("option")).toHaveText([
      copy.choose,
      "GPT-6 Astra (gpt-6-astra)",
      "GPT-6 Sol (gpt-6-sol)",
      "GPT-5.5 (gpt-5.5)",
      copy.custom,
    ]);
    await expect(page.getByRole("textbox", { name: copy.modelId })).toHaveCount(0);
    await model.click();
    await page.getByRole("combobox", { name: copy.search }).fill("sol");
    const options = page.getByRole("listbox", { name: `${copy.model}: ${copy.options}` });
    await expect(options.getByRole("option")).toHaveText(["GPT-6 Sol (gpt-6-sol)"]);
    await options.getByRole("option", { name: "GPT-6 Sol (gpt-6-sol)" }).click();
    await expect(model).toHaveValue("gpt-6-sol");
    await wizardFinish(page, { language: copy.language });
    await expect
      .poll(() => state.saved?.model)
      .toEqual({ connectionId: "openclaw:test", modelId: "gpt-6-sol" });
    await expect(page).toHaveURL(/\/agents\/new\/chats\/new-chat$/);
    expect(state.refreshes).toBe(0);
  });

  test(`${language}: the connection select names the provider with the account`, async ({
    page,
  }) => {
    await setup(page, { language });
    await newAgent(page, copy);
    await expect(page.getByLabel(copy.connection).locator("option:checked")).toHaveText(
      "ChatGPT · Personal ChatGPT",
    );
  });

  test(`${language}: a list that cannot load shows the hint and free text, refresh loads it`, async ({
    page,
  }) => {
    const state = await setup(page, { language, models: [] });
    await newAgent(page, copy);
    await expect(page.getByText(copy.failed)).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: copy.model, exact: true }),
    ).toHaveCount(0);
    await page.getByRole("textbox", { name: copy.modelId }).fill("gpt-6-custom");
    let release;
    state.refreshAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve({ models: listed, modelCatalog: "ready" });
      });
    await page.getByRole("button", { name: copy.refresh }).click();
    await expect(
      page.getByRole("status").filter({ hasText: copy.loading }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: copy.refresh })).toBeDisabled();
    release();
    const model = page.getByRole("combobox", { name: copy.model, exact: true });
    await expect(model).toBeVisible();
    await expect(page.getByText(copy.failed)).toHaveCount(0);
    // The typed ID stays: it is not in the list, so the custom choice remains.
    await expect(model.locator("option:checked")).toHaveText(copy.custom);
    await expect(page.getByRole("textbox", { name: copy.modelId })).toHaveValue(
      "gpt-6-custom",
    );
    await model.selectOption("gpt-6-astra");
    await model.selectOption({ label: copy.custom });
    await page.getByRole("textbox", { name: copy.modelId }).fill("gpt-6-preview");
    await wizardFinish(page, { language: copy.language });
    await expect
      .poll(() => state.saved?.model)
      .toEqual({ connectionId: "openclaw:test", modelId: "gpt-6-preview" });
    await expect(page).toHaveURL(/\/agents\/new\/chats\/new-chat$/);
  });

  test(`${language}: a failed refresh keeps the list, says it may be out of date`, async ({
    page,
  }) => {
    const state = await setup(page, { language });
    await newAgent(page, copy);
    state.refreshAnswer = () => ({ status: 429 });
    await page.getByRole("button", { name: copy.refresh }).click();
    await expect(page.getByText(copy.stale)).toBeVisible();
    await expect(page.getByText(copy.failed)).toHaveCount(0);
    const model = page.getByRole("combobox", { name: copy.model, exact: true });
    await expect(model).toHaveAttribute(
      "aria-describedby",
      await page.getByText(copy.stale).getAttribute("id"),
    );
    await expect(model.locator("option")).toHaveCount(5);
    await model.selectOption({ label: copy.custom });
    await page.getByRole("textbox", { name: copy.modelId }).fill("gpt-6-astra-mini");
    await expect(page.getByText(/Too many|429/)).toHaveCount(0);
  });

  test(`${language}: a list checked with another account and an empty list say so`, async ({
    page,
  }) => {
    const state = await setup(page, { language, modelCatalog: "unknown" });
    await newAgent(page, copy);
    await expect(page.getByText(copy.unknown)).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: copy.model, exact: true }).locator("option"),
    ).toHaveCount(5);
    Object.assign(state.account, { models: [], modelCatalog: "ready" });
    await page.getByRole("button", { name: copy.refresh }).click();
    await expect(page.getByText(copy.failed)).toBeVisible();
    await expect(page.getByRole("textbox", { name: copy.modelId })).toBeVisible();
  });

  test(`${language}: an agent's saved model outside the list stays a custom ID`, async ({
    page,
  }) => {
    const account = {
      id: "openclaw:test",
      name: "Personal ChatGPT",
      providerId: "openai-chatgpt",
      status: "ok",
      available: true,
      models: listed,
      modelCatalog: "ready",
    };
    const state = await setupAssistantSettings(page, {
      language,
      assistant: { model: { connectionId: "openclaw:test", modelId: "gpt-6-legacy" } },
      models: [account],
    });
    await page.goto(baseURL + "/agents/home/settings?tab=identity");
    const model = page.getByRole("combobox", { name: copy.model, exact: true });
    await expect(model.locator("option:checked")).toHaveText(copy.custom);
    await expect(page.getByRole("textbox", { name: copy.modelId })).toHaveValue(
      "gpt-6-legacy",
    );
    // A failed refresh's hint lasts only until the server reports a newer state.
    await page.route("**/models/refresh", (route) =>
      route.fulfill({ status: 429, json: {} }),
    );
    await page.getByRole("button", { name: copy.refresh }).click();
    await expect(page.getByText(copy.stale)).toBeVisible();
    account.modelCatalog = "unknown";
    await emitChange(page);
    await expect(page.getByText(copy.unknown)).toBeVisible();
    await expect(page.getByText(copy.stale)).toHaveCount(0);
    // The Profile tab's bar saves a listed model as the agent's model.
    await model.selectOption("gpt-6-sol");
    await page.getByRole("button", { name: copy.save }).click();
    await expect
      .poll(() => state.updates.at(-1)?.model)
      .toEqual({ connectionId: "openclaw:test", modelId: "gpt-6-sol" });
  });
}

test("screenshots: the open ChatGPT model list on desktop and mobile", async ({
  page,
}) => {
  test.skip(!shots, "set AGENTPIER_CHATGPT_MODEL_SHOTS to capture review screenshots");
  fs.mkdirSync(shots, { recursive: true });
  await setupAssistantSettings(page, {
    assistant: { model: { connectionId: "openclaw:test", modelId: "gpt-6-sol" } },
    models: [
      {
        id: "openclaw:test",
        name: "Personal ChatGPT",
        providerId: "openai-chatgpt",
        status: "ok",
        available: true,
        models: listed,
        modelCatalog: "unknown",
      },
    ],
  });
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport);
    // The Identity tab of an existing agent, with the account's hint showing.
    await page.goto(baseURL + "/agents/home/settings?tab=identity");
    const model = page.getByRole("combobox", { name: english.model, exact: true });
    await expect(page.getByText(english.unknown)).toBeVisible();
    await page.getByRole("button", { name: english.refresh }).scrollIntoViewIfNeeded();
    await model.click();
    await expect(page.getByRole("combobox", { name: english.search })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: path.join(shots, `agent-editor-chatgpt-models-${name}-en.png`),
    });
  }
});
