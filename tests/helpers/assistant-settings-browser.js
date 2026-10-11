import { fulfillEnabledAssistantFeature } from "./assistant-browser-fixture.js";
import { fixture } from "../browser/providers-fixture.js";

export const home = (extra = {}) => ({
  id: "home",
  name: "Home",
  instructions: "Plan meals",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: false, reminders: false },
  ...extra,
});
export async function setupAssistantSettings(page, options = {}) {
  await fixture(page);
  await page.addInitScript((language) => {
    localStorage.setItem("agentpier-language", language);
    const Native = window.EventSource;
    window.__streams = [];
    window.EventSource = class extends Native {
      constructor(url) {
        super(url);
        window.__streams.push(this);
      }
    };
  }, options.language || "en");
  const state = {
    assistants: options.assistants || [home(options.assistant)],
    conversations: options.conversations || [],
    runtime: options.runtime || { availability: "ready", sync: "current" },
    channel: options.channel || null,
    reminders: options.reminders || [],
    routines: options.routines || [],
    channelDelay: 0,
    actionDelay: options.actionDelay || 0,
    inflight: { actions: 0, maxActions: 0 },
    counts: { channels: 0 },
    reviews: [],
    updates: [],
    opened: 0,
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistants/home" && method === "PATCH") {
      const body = route.request().postDataJSON();
      state.updates.push(body);
      if (options.saveDelay) await new Promise((r) => setTimeout(r, options.saveDelay));
      if (options.saveStatus)
        return route.fulfill({
          status: options.saveStatus,
          json: { error: options.saveError || "Revision conflict" },
        });
      if (options.applyUpdates) {
        const { revision: _revision, confirmInstructions: _confirm, ...fields } = body;
        state.assistants[0] = {
          ...state.assistants[0],
          ...fields,
          revision: state.assistants[0].revision + 1,
        };
      }
      return route.fulfill({ json: state.assistants[0] });
    }
    if (path === "/api/assistants/home/conversations" && method === "POST") {
      state.opened += 1;
      return route.fulfill({ json: { id: "c1", assistantId: "home" } });
    }
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: state.assistants,
          conversations: state.conversations,
          models: options.models || [{ id: "router", name: "Router", available: true }],
        },
      });
    if (path === "/api/assistant-runtime") return route.fulfill({ json: state.runtime });
    if (path === "/api/assistant-channels") {
      state.counts.channels += 1;
      if (state.channelDelay) await new Promise((r) => setTimeout(r, state.channelDelay));
      return route.fulfill({ json: { channels: state.channel ? [state.channel] : [] } });
    }
    if (/\/inputs\/[^/]+\/review$/.test(path) && method === "POST") {
      state.reviews.push(path);
      return route.fulfill({ json: [] });
    }
    if (path === "/api/assistants/home/actions") {
      state.inflight.actions += 1;
      state.inflight.maxActions = Math.max(
        state.inflight.maxActions,
        state.inflight.actions,
      );
      if (state.actionDelay) await new Promise((r) => setTimeout(r, state.actionDelay));
      state.inflight.actions -= 1;
      return route.fulfill({ json: { actions: [] } });
    }
    if (path === "/api/assistants/home/reminders")
      return route.fulfill({ json: { reminders: state.reminders } });
    if (path === "/api/assistants/home/routines")
      return route.fulfill({ json: { routines: state.routines } });
    if (path === "/api/assistants/home/memory")
      return route.fulfill({ json: { name: "MEMORY.md", content: "", revision: 1 } });
    if (path === "/api/assistant-model-accounts")
      return route.fulfill({ json: { accounts: [] } });
    if (path === "/api/assistant-speech")
      return route.fulfill({
        json: { revision: 0, model: "nova-3", language: "auto", hasSecret: false },
      });
    if (path === "/api/assistants/home/access")
      return route.fulfill({ json: { revision: 0 } });
    if (path === "/api/assistant-workspace-catalog")
      return route.fulfill({ json: { projects: [], pipelines: [] } });
    if (path.endsWith("/messages"))
      return route.fulfill({ json: { messages: [], requests: [] } });
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
export const emitChange = (page) =>
  page.evaluate(() =>
    window.__streams.forEach((stream) =>
      stream.onmessage?.({ data: JSON.stringify({ type: "change" }) }),
    ),
  );
