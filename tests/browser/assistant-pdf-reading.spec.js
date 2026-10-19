import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

const home = {
  id: "home",
  name: "Home",
  instructions: "Plan meals",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: false, reminders: false },
};
// A local endpoint whose listed model accepts images.
const vision = {
  id: "vision",
  name: "Local",
  providerId: "endpoint",
  available: true,
  models: [{ modelId: "vl-1", label: "VL 1" }],
};

async function setup(page, { language = "en", pdf = {} } = {}) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = {
    patches: [],
    puts: [],
    pdf: { revision: 0, ready: false, reason: "notSet", ...pdf },
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistants/home" && method === "PATCH") {
      const body = request.postDataJSON();
      state.patches.push(body);
      return route.fulfill({ json: { ...home, ...body, revision: 2 } });
    }
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [home],
          conversations: [],
          models: [{ id: "router", name: "Router", available: true }, vision],
        },
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({
        json: { availability: "ready", sync: "current", browser: { available: true } },
      });
    if (path === "/api/assistant-pdf-model") {
      if (method === "PUT") {
        const body = request.postDataJSON();
        state.puts.push(body);
        state.pdf = body.connectionId
          ? {
              revision: state.pdf.revision + 1,
              connectionId: body.connectionId,
              modelId: body.modelId,
              ready: true,
            }
          : { revision: state.pdf.revision + 1, ready: false, reason: "notSet" };
      }
      return route.fulfill({ json: state.pdf });
    }
    if (path === "/api/assistant-web-search")
      return route.fulfill({
        json: { revision: 0, provider: "duckduckgo", hasBraveKey: false, ready: true },
      });
    if (path === "/api/assistant-model-accounts")
      return route.fulfill({ json: { accounts: [] } });
    if (path === "/api/assistant-speech")
      return route.fulfill({
        json: { revision: 0, model: "nova-3", language: "auto", hasSecret: false },
      });
    if (path === "/api/assistant-channels")
      return route.fulfill({ json: { channels: [] } });
    return route.fulfill({ json: {} });
  });
  return state;
}

const copy = {
  en: {
    capability: "Read PDFs",
    unavailable:
      "Choose a PDF model under Accounts › Services for agents › PDF reading first.",
    referenceUnset: "PDF model · Not chosen",
    referenceSet: "PDF model · vl-1",
    title: "PDF reading",
    notSet: "No model chosen: agents cannot read PDFs until you choose one.",
    connection: "Model connection",
    model: "Model",
    save: "Save PDF model",
    ready: "Ready",
    remove: "Remove PDF model",
    saveAgent: "Save agent",
    unsaved: "Unsaved changes",
  },
  de: {
    capability: "PDFs lesen",
    unavailable:
      "Wähle zuerst unter Accounts › Dienste für Agenten › PDF-Lesen ein PDF-Modell.",
    referenceUnset: "PDF-Modell · Nicht gewählt",
    referenceSet: "PDF-Modell · vl-1",
    title: "PDF-Lesen",
    notSet: "Kein Modell gewählt: Agenten können erst PDFs lesen, wenn du eines wählst.",
    connection: "Provider-Zugang",
    model: "Modell",
    save: "PDF-Modell speichern",
    ready: "Bereit",
    remove: "PDF-Modell entfernen",
    saveAgent: "Agent speichern",
    unsaved: "Ungespeicherte Änderungen",
  },
};

for (const language of ["en", "de"]) {
  const t = copy[language];
  test.describe(language, () => {
    test("Read PDFs stays off until the owner chooses a PDF model", async ({ page }) => {
      const state = await setup(page, { language });
      await page.goto(baseURL + settingsPath("capabilities"));
      const pdf = page.getByLabel(t.capability, { exact: true });
      await expect(pdf).toBeDisabled();
      await expect(pdf).not.toBeChecked();
      await expect(page.getByText(t.unavailable)).toBeVisible();
      // The reference row leads to the one place the model is chosen.
      await page.getByRole("link", { name: t.referenceUnset }).click();
      await expect(page).toHaveURL(/section=services&item=pdf-model/);
      const panel = page.locator(".accounts-detail");
      await expect(panel.getByRole("heading", { name: t.title })).toBeVisible();
      await expect(panel.getByText(t.notSet)).toBeVisible();
      await panel.getByLabel(t.connection).selectOption("vision");
      await panel
        .getByRole("combobox", { name: t.model, exact: true })
        .selectOption("vl-1");
      await panel.getByRole("button", { name: t.save }).click();
      await expect.poll(() => state.puts.length).toBe(1);
      expect(state.puts[0]).toEqual({
        revision: 0,
        connectionId: "vision",
        modelId: "vl-1",
      });
      await expect(panel.getByText(t.ready, { exact: true })).toBeVisible();
      await expect(
        page.locator(".accounts-hub").getByRole("link", { name: new RegExp(t.title) }),
      ).toContainText(`vl-1 · ${t.ready}`);
      if (language === "en")
        await page.screenshot({
          path: ".cache/assistant-pdf-model-en.png",
          fullPage: true,
        });
      // Removing saves at once and makes PDF reading unavailable again.
      await panel.getByRole("button", { name: t.remove }).click();
      await expect.poll(() => state.puts.length).toBe(2);
      expect(state.puts[1]).toEqual({ revision: 1, connectionId: null, modelId: null });
      await expect(panel.getByText(t.notSet)).toBeVisible();
    });

    test("with a PDF model the Read PDFs switch is saved with the agent", async ({
      page,
    }) => {
      const state = await setup(page, {
        language,
        pdf: { revision: 1, connectionId: "vision", modelId: "vl-1", ready: true },
      });
      await page.goto(baseURL + settingsPath("capabilities"));
      await expect(page.getByRole("link", { name: t.referenceSet })).toBeVisible();
      const pdf = page.getByLabel(t.capability, { exact: true });
      await expect(pdf).toBeEnabled();
      await pdf.check();
      await saveBar(page, t.unsaved).getByRole("button", { name: t.saveAgent }).click();
      await expect.poll(() => state.patches.length).toBe(1);
      expect(state.patches[0].capabilities).toMatchObject({
        readPdfs: true,
        documents: false,
      });
      if (language === "en")
        await page.screenshot({
          path: ".cache/assistant-pdf-capability-en.png",
          fullPage: true,
        });
    });
  });
}

test("a PDF model's lost connection is explained on the switch", async ({ page }) => {
  await setup(page, {
    pdf: {
      revision: 2,
      connectionId: "gone",
      modelId: "vl-1",
      ready: false,
      reason: "connectionMissing",
    },
  });
  await page.goto(baseURL + settingsPath("capabilities"));
  await expect(page.getByLabel("Read PDFs", { exact: true })).toBeDisabled();
  await expect(
    page.getByText("The PDF model's connection no longer exists."),
  ).toBeVisible();
});
