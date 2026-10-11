import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
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
const affected = { agents: [{ id: "home", name: "Home" }], teamMembers: 0 };
async function setup(page, options = {}) {
  const controls = await fixture(page);
  controls.state.providerConnections = options.connections || [];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = {
    patches: [],
    creates: [],
    puts: [],
    restartFirst: options.restartFirst ?? false,
    search: {
      revision: 0,
      provider: "duckduckgo",
      hasBraveKey: false,
      ready: true,
      ...options.search,
    },
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
      if (state.restartFirst && !body.confirmRestart)
        return route.fulfill({
          status: 409,
          json: {
            code: "ASSISTANT_RESTART_REQUIRED",
            error: "Neustart nötig",
            messageKey: "assistants.webToolsRestartRequired",
            affected,
          },
        });
      return route.fulfill({ json: { ...home, revision: 2 } });
    }
    if (path === "/api/assistants" && method === "POST") {
      state.creates.push(request.postDataJSON());
      return route.fulfill({ json: { ...home, id: "fresh", revision: 1 } });
    }
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [home],
          conversations: [],
          models: [{ id: "router", name: "Router", available: true }],
        },
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({
        json: {
          availability: "ready",
          sync: "current",
          browser: options.browser || { available: true, name: "Chrome" },
        },
      });
    if (path === "/api/assistant-web-search") {
      if (method === "PUT") {
        const body = request.postDataJSON();
        state.puts.push(body);
        if (state.restartFirst && !body.confirmRestart)
          return route.fulfill({
            status: 409,
            json: {
              code: "ASSISTANT_RESTART_REQUIRED",
              error: "Neustart nötig",
              messageKey: "assistants.webToolsRestartRequired",
              affected,
            },
          });
        const hasBraveKey =
          body.braveKey === null
            ? false
            : body.braveKey
              ? true
              : state.search.hasBraveKey;
        state.search = {
          revision: state.search.revision + 1,
          provider: body.provider,
          ...(body.connectionId ? { connectionId: body.connectionId } : {}),
          hasBraveKey,
          ready: body.provider !== "brave" || hasBraveKey,
        };
      }
      return route.fulfill({ json: state.search });
    }
    if (path === "/api/assistant-model-accounts")
      return route.fulfill({ json: { accounts: [] } });
    if (path === "/api/assistant-speech")
      return route.fulfill({
        json: { revision: 0, model: "nova-3", language: "auto", hasSecret: false },
      });
    if (path.endsWith("/messages"))
      return route.fulfill({ json: { messages: [], requests: [] } });
    if (path === "/api/assistant-channels")
      return route.fulfill({ json: { channels: [] } });
    if (path === "/api/assistant-runtime/updates")
      return route.fulfill({
        json: {
          phase: "idle",
          blockers: [],
          currentVersion: "1",
          targetVersion: null,
          affectedAssistants: 0,
          busy: false,
          candidateReady: false,
          recoveryRequired: false,
        },
      });
    return route.fulfill({ json: {} });
  });
  return state;
}
const save = (page) =>
  page.locator("#agent-profile").getByRole("button", { name: "Save agent" });

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("capability switches send the full capabilities object", async ({ page }) => {
      const state = await setup(page);
      await page.goto(baseURL + "/agents/home/settings");
      await expect(page.getByText("Memory & reminders")).toBeVisible();
      await expect(page.getByText("Web & documents")).toBeVisible();
      await page.getByLabel("Search the web").check();
      await page.getByLabel("Read web pages").check();
      await page.getByLabel("Read images").check();
      await page.getByLabel("Remember information").check();
      await expect(page.getByLabel("Use a browser")).toBeEnabled();
      if (label === "phone") {
        const box = await page.locator("#agent-profile").boundingBox();
        expect(box.width).toBeLessThanOrEqual(390);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      }
      await save(page).click();
      await expect.poll(() => state.patches.length).toBe(1);
      expect(state.patches[0].capabilities).toEqual({
        memory: true,
        reminders: false,
        webSearch: true,
        webFetch: true,
        browser: false,
        documents: true,
      });
      expect(state.patches[0].confirmRestart).toBeUndefined();
    });

    test("the create form disables the web switches until the agent is saved", async ({
      page,
    }) => {
      const state = await setup(page);
      await page.goto(baseURL + "/agents");
      await page.getByRole("button", { name: "New agent" }).click();
      for (const name of [
        "Search the web",
        "Read web pages",
        "Use a browser",
        "Read images",
      ]) {
        await expect(page.getByLabel(name)).toBeDisabled();
        await expect(page.getByLabel(name)).not.toBeChecked();
      }
      await expect(page.getByText("Available after saving the agent")).toHaveCount(4);
      await expect(page.getByLabel("Remember information")).toBeEnabled();
      await page.getByLabel("Name", { exact: true }).fill("Fresh");
      await page.getByLabel("Model connection").selectOption("router");
      await page.getByRole("textbox", { name: "Model ID" }).fill("model");
      await page.getByLabel("Remember information").check();
      await page.getByRole("button", { name: "Save agent" }).click();
      await expect.poll(() => state.creates.length).toBe(1);
      expect(state.creates[0].capabilities).toMatchObject({
        memory: true,
        webSearch: false,
        webFetch: false,
        browser: false,
        documents: false,
      });
    });

    test("the browser switch is disabled and explained without a browser", async ({
      page,
    }) => {
      await setup(page, { browser: { available: false } });
      await page.goto(baseURL + "/agents/home/settings");
      const browser = page.getByLabel("Use a browser");
      await expect(browser).toBeDisabled();
      await expect(page.getByText("No supported browser found")).toBeVisible();
      await expect(page.getByLabel("Read web pages")).toBeEnabled();
    });

    test("web search is explained while the provider is not configured", async ({
      page,
    }) => {
      await setup(page, { search: { provider: "brave", ready: false } });
      await page.goto(baseURL + "/agents/home/settings");
      await expect(page.getByLabel("Search the web")).toBeDisabled();
      await expect(page.getByText("Web search is not set up")).toBeVisible();
    });

    test("a restart-required answer asks first and resubmits once confirmed", async ({
      page,
    }) => {
      const state = await setup(page, { restartFirst: true });
      await page.goto(baseURL + "/agents/home/settings");
      await page.getByLabel("Read web pages").check();
      await save(page).click();
      const dialog = page.getByRole("alertdialog", {
        name: "Restart the agent service?",
      });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Running work is not interrupted");
      await expect(dialog).toContainText("Home");
      expect(state.patches).toHaveLength(1);
      await dialog.getByRole("button", { name: "Save and restart" }).click();
      await expect.poll(() => state.patches.length).toBe(2);
      expect(state.patches[1].confirmRestart).toBe(true);
      expect(state.patches[1].capabilities.webFetch).toBe(true);
      await expect(dialog).toHaveCount(0);
    });

    test("web search settings store a Brave key without showing it", async ({ page }) => {
      const state = await setup(page);
      await page.goto(baseURL + "/accounts");
      const panel = page.getByRole("region", { name: "Web search" });
      await expect(panel.getByRole("radio", { name: /DuckDuckGo/ })).toBeChecked();
      await panel.getByRole("radio", { name: /Brave/ }).check();
      await expect(panel.getByText("No key stored")).toBeVisible();
      await panel.getByLabel("Brave API key").fill("BSA-secret-fixture-key");
      await panel.getByRole("button", { name: "Save search settings" }).click();
      await expect(panel.getByText("Key stored")).toBeVisible();
      await expect(panel.getByLabel("Brave API key")).toHaveValue("");
      expect(state.puts[0]).toEqual({
        revision: 0,
        provider: "brave",
        braveKey: "BSA-secret-fixture-key",
      });
      expect(await page.content()).not.toContain("BSA-secret-fixture-key");
      await panel.getByRole("button", { name: "Remove Brave key" }).click();
      await expect(panel.getByText("No key stored")).toBeVisible();
      expect(state.puts[1].braveKey).toBeNull();
      await expect(panel.getByText("Not configured")).toBeVisible();
    });

    test("Perplexity uses one of the OpenRouter connections", async ({ page }) => {
      const state = await setup(page, {
        connections: [
          {
            id: "or1",
            name: "My OpenRouter",
            providerId: "openrouter",
            hasSecret: true,
            launchable: true,
            tools: ["codex"],
          },
          {
            id: "oa1",
            name: "Other",
            providerId: "openai",
            hasSecret: true,
            launchable: true,
            tools: ["codex"],
          },
        ],
      });
      await page.goto(baseURL + "/accounts");
      const panel = page.getByRole("region", { name: "Web search" });
      await panel.getByRole("radio", { name: /Perplexity/ }).check();
      await expect(panel.getByRole("option", { name: "Other" })).toHaveCount(0);
      await panel.locator("select").selectOption("or1");
      await panel.getByRole("button", { name: "Save search settings" }).click();
      await expect.poll(() => state.puts.length).toBe(1);
      expect(state.puts[0]).toEqual({
        revision: 0,
        provider: "perplexity",
        connectionId: "or1",
      });
    });

    test("a search provider change asks before restarting the service", async ({
      page,
    }) => {
      const state = await setup(page, { restartFirst: true });
      await page.goto(baseURL + "/accounts");
      const panel = page.getByRole("region", { name: "Web search" });
      await panel.getByRole("radio", { name: /Perplexity/ }).check();
      await panel.getByRole("button", { name: "Save search settings" }).click();
      const dialog = panel.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Save and restart" }).click();
      await expect.poll(() => state.puts.length).toBe(2);
      expect(state.puts[1].confirmRestart).toBe(true);
      expect(state.puts[1].provider).toBe("perplexity");
    });
  });
}
