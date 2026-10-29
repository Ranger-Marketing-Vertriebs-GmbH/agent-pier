import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar } from "../helpers/agent-settings-page.js";
import { fixture } from "./providers-fixture.js";

// The agent web tools settings (assistant-web-tools.spec.js): one agent, the agent
// routes it reads and writes, and the web search settings. `setup` returns the state
// the routes record (patches, creates, puts, resets, restarts).
export const home = {
  id: "home",
  name: "Home",
  instructions: "Plan meals",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: false, reminders: false },
};
const affected = { agents: [{ id: "home", name: "Home" }], teamMembers: 0 };
export async function setup(page, options = {}) {
  const controls = await fixture(page);
  controls.state.providerConnections = options.connections || [];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const agent = { ...home, ...options.assistant };
  const state = {
    resets: 0,
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
    if (path === "/api/assistants/home/browser" && method === "GET")
      return route.fulfill({
        json: {
          running: false,
          visible: false,
          stored: !!options.stored,
          resettable: true,
        },
      });
    if (path === "/api/assistants/home/browser/reset" && method === "POST") {
      state.resets++;
      return route.fulfill({
        json: { running: false, visible: false, stored: false, resettable: true },
      });
    }
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
      return route.fulfill({ json: { ...agent, ...body, revision: 2 } });
    }
    if (path === "/api/assistants" && method === "POST") {
      state.creates.push(request.postDataJSON());
      return route.fulfill({ json: { ...home, id: "fresh", revision: 1 } });
    }
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [agent],
          conversations: [],
          models: [
            { id: "router", name: "Router", available: true },
            ...(options.models || []),
          ],
        },
      });
    if (path === "/api/assistant-runtime/restart" && method === "POST") {
      state.restarts = (state.restarts || 0) + 1;
      return route.fulfill({ status: 202, json: { availability: "starting" } });
    }
    if (path === "/api/assistant-runtime")
      return route.fulfill({
        json: {
          availability: "ready",
          sync: "current",
          browser: (state.installed && options.installedBrowser) ||
            options.browser || { available: true, name: "Chrome" },
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
// Phones save from the sticky save bar, desktop from the profile form.
export const save = (page) =>
  saveBar(page).getByRole("button", { name: "Save agent", exact: true });
