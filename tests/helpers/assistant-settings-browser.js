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
export const connectedChannel = (extra = {}) => ({
  id: "telegram",
  assistantId: "home",
  conversationId: "chat",
  username: "bot",
  enabled: true,
  hasSecret: true,
  chatId: "42",
  language: "en",
  appUrl: null,
  revision: 1,
  inputs: [],
  notifications: [],
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
    memory: options.memory || {},
    memorySaves: [],
    channelDelay: 0,
    actionDelay: options.actionDelay || 0,
    inflight: { actions: 0, maxActions: 0 },
    counts: { channels: 0 },
    reviews: [],
    updates: [],
    opened: 0,
    policies: options.policies || {
      home: { revision: 1, autonomous: false, maxMembers: 4, runTimeoutMinutes: 30 },
    },
    access: options.access || { revision: 0 },
    accessFailures: 0,
    catalog: options.catalog || { projects: [], pipelines: [] },
    saveFailures: [...(options.saveFailures || [])],
    channelFailures: [...(options.channelFailures || [])],
    work: [],
    actions: options.actions || [],
    channelPatches: [],
    // PATCH bodies of reminders and routines (pause, resume, Telegram).
    itemPatches: [],
  };
  if (options.mcpServers)
    await page.route("**/api/mcp-servers", (route) =>
      route.fulfill({ json: options.mcpServers }),
    );
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
      const failure = state.saveFailures.shift();
      if (failure)
        return route.fulfill({
          status: failure.status,
          json: failure.json ?? {
            error: failure.error,
            ...(failure.messageKey ? { messageKey: failure.messageKey } : {}),
          },
        });
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
          policies: state.policies,
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
      return route.fulfill({ json: { actions: state.actions } });
    }
    const item = /^\/api\/assistants\/home\/(reminders|routines)\/([^/]+)$/.exec(path);
    if (item && method === "PATCH") {
      const body = route.request().postDataJSON();
      state.itemPatches.push([item[1], item[2], body]);
      const list = state[item[1]];
      const index = list.findIndex((entry) => entry.id === item[2]);
      const { revision: _revision, ...change } = body;
      list[index] = { ...list[index], ...change, revision: list[index].revision + 1 };
      return route.fulfill({ json: list[index] });
    }
    if (path === "/api/assistants/home/reminders")
      return route.fulfill({ json: { reminders: state.reminders } });
    if (path === "/api/assistants/home/routines")
      return route.fulfill({ json: { routines: state.routines } });
    if (path === "/api/assistants/home/memory") {
      if (method === "PUT") {
        const body = route.request().postDataJSON();
        state.memorySaves.push(body);
        // Like native-memory.js: a stale hash is a 409 "assistants.conflict".
        if (body.expectedHash && state.memory[body.name]?.hash !== body.expectedHash)
          return route.fulfill({
            status: 409,
            json: { error: "Revision conflict", messageKey: "assistants.conflict" },
          });
        state.memory[body.name] = {
          name: body.name,
          content: body.content,
          hash: `saved-${state.memorySaves.length}`,
        };
        return route.fulfill({ json: state.memory[body.name] });
      }
      const name = new URL(route.request().url()).searchParams.get("name");
      return route.fulfill({
        json: state.memory[name] || { name, content: "", missing: true },
      });
    }
    if (path === "/api/assistant-model-accounts")
      return route.fulfill({ json: { accounts: [] } });
    if (path === "/api/assistant-speech")
      return route.fulfill({
        json: { revision: 0, model: "nova-3", language: "auto", hasSecret: false },
      });
    if (path === "/api/assistants/home/access") {
      if (state.accessFailures > 0) {
        state.accessFailures -= 1;
        return route.fulfill({ status: 500, json: { error: "Access unavailable" } });
      }
      return route.fulfill({ json: state.access });
    }
    if (path === "/api/assistant-teams")
      return route.fulfill({ json: { policies: state.policies } });
    if (path === "/api/assistant-workspace-catalog")
      return route.fulfill({ json: state.catalog });
    if (path === "/api/assistants/home/work" && method === "PUT") {
      const body = route.request().postDataJSON();
      state.work.push(body);
      const stale =
        (body.access && body.access.revision !== state.access.revision) ||
        (body.team && body.team.revision !== state.policies.home.revision);
      if (stale)
        return route.fulfill({
          status: 409,
          json: { error: "Revision conflict", messageKey: "assistants.conflict" },
        });
      if (body.access)
        state.access = {
          ...state.access,
          ...body.access,
          revision: state.access.revision + 1,
        };
      const team = state.policies.home;
      if (body.team)
        state.policies.home = { ...team, ...body.team, revision: team.revision + 1 };
      return route.fulfill({ json: { access: state.access, team: state.policies.home } });
    }
    if (/^\/api\/assistant-channels\/[^/]+$/.test(path) && method === "DELETE") {
      state.disconnects = (state.disconnects || 0) + 1;
      state.channel = {
        ...state.channel,
        hasSecret: false,
        enabled: false,
        revision: state.channel.revision + 1,
      };
      return route.fulfill({ json: state.channel });
    }
    if (/^\/api\/assistant-channels\/[^/]+$/.test(path) && method === "PATCH") {
      const body = route.request().postDataJSON();
      state.channelPatches.push(body);
      const failure = state.channelFailures.shift();
      if (failure)
        return route.fulfill({ status: failure.status, json: { error: failure.error } });
      if (body.revision !== state.channel.revision)
        return route.fulfill({
          status: 409,
          json: { error: "Revision conflict", messageKey: "assistants.conflict" },
        });
      const { revision: _revision, ...fields } = body;
      state.channel = {
        ...state.channel,
        ...fields,
        revision: state.channel.revision + 1,
      };
      return route.fulfill({ json: state.channel });
    }
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
