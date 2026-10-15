import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

const levels = ["off", "approval", "full"];
export const profile = {
  id: "home",
  name: "Home",
  instructions: "Plan meals",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: false, reminders: false },
};
export const command = `/opt/homebrew/bin/gh pr list --limit 5 ${"--json title ".repeat(80)}`;
export const execAction = (id, extra = {}) => ({
  id,
  revision: 1,
  assistantId: "home",
  state: "awaiting_approval",
  createdAt: "2026-10-11T10:00:00.000Z",
  expiresAt: "2026-10-11T10:30:00.000Z",
  payload: {
    action: "exec",
    command,
    cwd: "/Users/owner/Projects/demo",
    agentId: "agentpier-home",
    allowedDecisions: ["allow-once", "deny"],
  },
  allowAlwaysByAgentPier: true,
  allowAlwaysPlan: {
    kind: "paths",
    paths: ["/opt/homebrew/bin/gh"],
    writable: ["/opt/homebrew/bin/gh"],
  },
  ...extra,
});

// A stand-in for the server: raising the level needs confirmShell, full also
// confirmFull, lowering needs neither (server/features/assistants/shell-changes.js).
// `activity`, `members` and `requests` (the chat's turns) put the agent mid-turn;
// `assistants` adds other agents, such as a lead's member.
export async function setup(page, options = {}) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = {
    agent: { ...profile, ...options.agent },
    patches: [],
    deletes: [],
    creates: [],
    decisions: [],
    actions: options.actions || [],
    entries: options.entries || [],
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
      const from = state.agent.shell || "off";
      if (body.shell && levels.indexOf(body.shell) > levels.indexOf(from)) {
        const required = [
          ...(body.confirmShell ? [] : ["confirmShell"]),
          ...(body.shell === "full" && !body.confirmFull ? ["confirmFull"] : []),
        ];
        if (required.length)
          return route.fulfill({
            status: 409,
            json: {
              code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
              error: "Bestätigung nötig",
              required,
            },
          });
      }
      state.agent = {
        ...state.agent,
        ...(body.shell ? { shell: body.shell } : {}),
        ...(options.pending ? { shellPending: true } : {}),
        revision: state.agent.revision + 1,
      };
      return route.fulfill({ json: { ...state.agent, pending: !!options.pending } });
    }
    if (path === "/api/assistants/home/shell-allowlist")
      return route.fulfill({ json: { entries: state.entries } });
    if (path.startsWith("/api/assistants/home/shell-allowlist/") && method === "DELETE") {
      const entry = decodeURIComponent(path.split("/").pop());
      state.deletes.push(entry);
      if (entry === "broken")
        return route.fulfill({
          status: 503,
          json: { code: "unavailable", error: "The agent service is not ready." },
        });
      state.entries = state.entries.filter((e) => e.id !== entry);
      return route.fulfill({ json: { removed: entry, entries: state.entries } });
    }
    if (path === "/api/assistants/home/actions")
      return route.fulfill({ json: { actions: state.actions } });
    if (path.endsWith("/decision")) {
      const id = path.split("/")[3];
      state.decisions.push([id, request.postDataJSON()]);
      state.actions = state.actions.filter((a) => a.id !== id);
      // Decided elsewhere or expired: the server refuses and drops it from the list.
      if (id === "stale")
        return route.fulfill({
          status: 409,
          json: { code: "conflict", error: "This request was already decided." },
        });
      return route.fulfill({ json: {} });
    }
    if (path === "/api/assistants" && method === "POST") {
      const body = request.postDataJSON();
      state.creates.push(body);
      if (body.shell && body.shell !== "off" && !body.confirmShell)
        return route.fulfill({
          status: 409,
          json: {
            code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
            error: "Bestätigung nötig",
            required: ["confirmShell"],
          },
        });
      return route.fulfill({ json: { ...profile, id: "fresh", shell: body.shell } });
    }
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [state.agent, ...(options.assistants || [])],
          conversations: [{ id: "chat", assistantId: "home" }],
          models: [{ id: "router", name: "Router", available: true }],
          members: options.members || [],
          activity: options.activity || {},
        },
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path === "/api/assistant-web-search")
      return route.fulfill({
        json: { revision: 0, provider: "duckduckgo", ready: true },
      });
    if (path.endsWith("/messages"))
      return route.fulfill({
        json: { messages: [], requests: options.requests || [], stale: false },
      });
    if (path === "/api/assistant-channels")
      return route.fulfill({ json: { channels: [] } });
    return route.fulfill({ json: {} });
  });
  return state;
}
