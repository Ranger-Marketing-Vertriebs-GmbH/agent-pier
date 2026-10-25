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
              images: true,
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
    description:
      "Reads PDF files in its workspace with its own model, page images included if that model accepts images.",
    referenceUnset: "PDF fallback · Not chosen",
    referenceSet: "PDF fallback · vl-1",
    title: "PDF reading",
    intro: "This optional fallback model reads them for agents whose model does not",
    notSet:
      "No fallback model: agents whose model does not accept images read only the text of PDFs.",
    connection: "Model connection",
    model: "Model",
    save: "Save fallback model",
    ready: "Ready",
    remove: "Remove fallback model",
    saveAgent: "Save agent",
    textOnly:
      "This model does not accept images either: it reads the text of PDFs, but not scanned pages or pages without text.",
    missing: "The chosen connection no longer exists. Choose another model.",
    unsaved: "Unsaved changes",
  },
  de: {
    capability: "PDFs lesen",
    description:
      "Liest PDF-Dateien in seinem Arbeitsordner mit seinem eigenen Modell, samt Seitenbildern, wenn dieses Modell Bilder annimmt.",
    referenceUnset: "PDF-Ersatzmodell · Nicht gewählt",
    referenceSet: "PDF-Ersatzmodell · vl-1",
    title: "PDF-Lesen",
    intro:
      "Dieses optionale Ersatzmodell liest sie für Agenten, deren Modell das nicht tut",
    notSet:
      "Kein Ersatzmodell: Agenten, deren Modell keine Bilder annimmt, lesen nur den Text von PDFs.",
    connection: "Provider-Zugang",
    model: "Modell",
    save: "Ersatzmodell speichern",
    ready: "Bereit",
    remove: "Ersatzmodell entfernen",
    saveAgent: "Agent speichern",
    textOnly:
      "Auch dieses Modell nimmt keine Bilder an: Es liest den Text von PDFs, aber keine gescannten Seiten oder Seiten ohne Text.",
    missing: "Den gewählten Zugang gibt es nicht mehr. Wähle ein anderes Modell.",
    unsaved: "Ungespeicherte Änderungen",
  },
};

for (const language of ["en", "de"]) {
  const t = copy[language];
  test.describe(language, () => {
    test("Read PDFs works without a fallback, which the owner may choose", async ({
      page,
    }) => {
      const state = await setup(page, { language });
      await page.goto(baseURL + settingsPath("capabilities"));
      const pdf = page.getByLabel(t.capability, { exact: true });
      // Agents read with their own model: no fallback is needed.
      await expect(pdf).toBeEnabled();
      await expect(page.getByText(t.description)).toBeVisible();
      // The reference row leads to the one place the fallback is chosen.
      await page.getByRole("link", { name: t.referenceUnset }).click();
      await expect(page).toHaveURL(/section=services&item=pdf-model/);
      const panel = page.locator(".accounts-detail");
      await expect(panel.getByRole("heading", { name: t.title })).toBeVisible();
      await expect(panel.getByText(t.intro)).toBeVisible();
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
      // Removing saves at once; agents keep reading with their own model.
      await panel.getByRole("button", { name: t.remove }).click();
      await expect.poll(() => state.puts.length).toBe(2);
      expect(state.puts[1]).toEqual({ revision: 1, connectionId: null, modelId: null });
      await expect(panel.getByText(t.notSet)).toBeVisible();
    });

    test("a text-only fallback is usable and says scans stay unreadable", async ({
      page,
    }) => {
      await setup(page, {
        language,
        pdf: {
          revision: 1,
          connectionId: "vision",
          modelId: "vl-1",
          images: false,
          ready: true,
        },
      });
      await page.goto(baseURL + settingsPath("capabilities"));
      await expect(page.getByLabel(t.capability, { exact: true })).toBeEnabled();
      await page.getByRole("link", { name: t.referenceSet }).click();
      const panel = page.locator(".accounts-detail");
      await expect(panel.getByText(t.ready, { exact: true })).toBeVisible();
      await expect(panel.getByRole("note")).toContainText(t.textOnly);
    });

    test("the Read PDFs switch is saved with the agent", async ({ page }) => {
      const state = await setup(page, { language });
      await page.goto(baseURL + settingsPath("capabilities"));
      await expect(page.getByRole("link", { name: t.referenceUnset })).toBeVisible();
      const pdf = page.getByLabel(t.capability, { exact: true });
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

    test("a fallback's lost connection leaves the switch usable", async ({ page }) => {
      await setup(page, {
        language,
        pdf: {
          revision: 2,
          connectionId: "gone",
          modelId: "vl-1",
          ready: false,
          reason: "connectionMissing",
        },
      });
      await page.goto(baseURL + settingsPath("capabilities"));
      await expect(page.getByLabel(t.capability, { exact: true })).toBeEnabled();
      await page.getByRole("link", { name: t.referenceSet }).click();
      await expect(page.locator(".accounts-detail").getByText(t.missing)).toBeVisible();
    });
  });
}
