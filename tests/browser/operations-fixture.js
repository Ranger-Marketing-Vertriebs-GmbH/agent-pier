import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { operationState, operationResponse } from "./operations-http-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
const category = (total) => ({ total, problems: [], warnings: [], unknown: [] });
// GET /connections/problems from the Settings summary's counts; an unknown count is
// a category that could not be read (null).
const connectionProblems = (summary) => ({
  agentsEnabled: false,
  models: category(0),
  services: null,
  mcp: category(0),
  ssh: summary.access.ssh ? category(summary.access.ssh.count) : null,
  secrets: summary.access.secrets ? category(summary.access.secrets.count) : null,
  github: summary.access.github ? category(summary.access.github.count) : null,
});
export async function operationsFixture(page, { tool = "codex", session = {} } = {}) {
  const chat = { messages: [], tasks: [], availability: "ready" };
  const state = {
    ...operationState(),
    calls: [],
    fail: "",
    hold: "",
    preferences: {},
    release: null,
    requests: [],
    summary: {
      access: {
        mcp: { available: true, activeGrants: 2 },
        remote: { tailscale: true, network: false },
        ssh: { count: 3 },
        secrets: { count: 2 },
        github: { count: 1 },
      },
      operations: {
        diagnostics: { generatedAt: "2026-10-12T09:14:00.000Z", failed: 0, warnings: 0 },
        backups: { count: 4, lastAt: "2026-10-12T03:00:00.000Z" },
        updates: { current: "1.0.0", checked: true, available: "1.1.0" },
      },
    },
    remote: {
      local: { url: "http://127.0.0.1:4380" },
      tailscale: { url: "https://host.example.ts.net:8443" },
      network: {
        saved: { enabled: false, bind: "0.0.0.0", hosts: [] },
        running: { enabled: false, bind: "0.0.0.0", hosts: [] },
        detected: { addresses: ["192.168.1.20"], hostname: "macmini" },
        urls: [],
        restartRequired: false,
        locked: false,
      },
    },
    health: {
      application: "agentpier",
      version: "0.0.0-test",
      instanceId: "one",
      warnings: [],
    },
    events: Array.from({ length: 26 }, (_, i) => ({
      id: String(26 - i),
      createdAt: "2026-09-07T12:00:00Z",
      action: "session.start",
      resourceType: "session",
      resourceId: "fixture-session",
      sessionId: "fixture-session",
      outcome: i === 25 ? "failure" : "success",
      source: "user",
      details: { tool: "codex" },
    })),
  };
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.slice(4),
      method = request.method(),
      body = ["POST", "PATCH", "PUT"].includes(method)
        ? request.headers()["content-type"] === "application/octet-stream"
          ? null
          : request.postDataJSON()
        : null;
    state.calls.push({ path, method, body });
    if (state.hold === path) await new Promise((resolve) => (state.release = resolve));
    if (state.fail === path)
      return route.fulfill({ status: 409, json: { error: "Fixture conflict" } });
    // A request that fails once, such as a dropped upload slice.
    if (state.failOnce?.path === path && state.failOnce.method === method) {
      state.failOnce = null;
      return route.fulfill({ status: 503, json: { error: "Fixture outage" } });
    }
    let result;
    if (path === "/state")
      result = {
        tools: [{ id: tool, name: tool, installed: true }],
        accounts: [{ id: "local-codex", tool, kind: "local", name: "Codex lokal" }],
        sessions: [
          {
            id: "fixture-session",
            name: "Fixture session",
            tool,
            accountId: "local-codex",
            status: "running",
            cwd: "/fixture",
            nativeRequests: { enabled: true, version: 1 },
            ...session,
          },
        ],
        home: "/fixture",
        defaultCwd: "/fixture",
        ...state.preferences,
      };
    else if (path === "/notifications")
      result = { enabled: true, publicKey: "AQIDBA", subscriptions: [] };
    else if (path === "/preferences") {
      if (method === "PATCH") state.preferences = { ...state.preferences, ...body };
      result = {
        defaultCwd: "/fixture",
        autoResumeInterrupted: true,
        ...state.preferences,
      };
    } else if (path === "/repositories")
      result = {
        credentials: [],
        projects: [
          { id: "fixture-repository", name: "Fixture project", path: "/fixture/project" },
        ],
      };
    else if (path === "/memory/projects")
      result = {
        projects: [
          { id: "fixture-project", name: "Fixture project", cwd: "/fixture/project" },
        ],
      };
    else if (path === "/audit") {
      const events = state.events.filter(
        (event) =>
          (!url.searchParams.get("outcome") ||
            event.outcome === url.searchParams.get("outcome")) &&
          (!url.searchParams.get("action") ||
            event.action === url.searchParams.get("action")),
      );
      const pageNumber = Number(url.searchParams.get("page") || 1);
      result = {
        events: events.slice((pageNumber - 1) * 25, pageNumber * 25),
        page: pageNumber,
        pageSize: 25,
        total: events.length,
        before: url.searchParams.get("before") || "26",
      };
    } else if (path.startsWith("/operations/"))
      result = operationResponse(state, path, method, body, url.searchParams);
    else if (path.endsWith("/requests"))
      result = {
        requests: state.requests,
        ...(state.requestIntegration ? { integration: state.requestIntegration } : {}),
        ...(state.requestNotice ? { notice: state.requestNotice } : {}),
      };
    else if (/\/requests\/[^/]+\/touch$/.test(path)) result = {};
    else if (/\/requests\/[^/]+\/(answer|handoff)$/.test(path)) {
      state.requests = [];
      result = { requests: [] };
    } else if (/\/input(?:\/[^/]+)?$/.test(path)) {
      // Chat delivery: a message sent while a request is open is held until it
      // is answered, then handed off.
      const deliveryId = body?.deliveryId || path.split("/").at(-1);
      if (body) state.inputs = [...(state.inputs || []), body];
      result = state.requests.length
        ? { deliveryId, status: "pending", waiting: "request" }
        : { deliveryId, status: "handed-off" };
    } else if (path.endsWith("/chat")) result = chat;
    else if (path === "/pipeline-profiles") result = { profiles: [] };
    else if (path === "/secrets") result = { secrets: [] };
    else if (path === "/sandbox-profiles") result = { available: false, profiles: [] };
    else if (path.endsWith("/models"))
      result = { currentModel: null, picker: null, pending: false };
    else if (path === "/remote" && method === "GET") result = state.remote;
    else if (path === "/remote" && method === "PUT") {
      state.remote.network.saved = body.network;
      state.remote.network.restartRequired = true;
      state.remote.network.urls = [
        ...body.network.hosts.map((host) => `http://${host}:4380`),
        "http://macmini:4380",
        "http://macmini.local:4380",
        "http://192.168.1.20:4380",
      ];
      result = state.remote;
    } else if (path === "/remote/restart") {
      state.health = { ...state.health, instanceId: "two" };
      state.remote.network.running = state.remote.network.saved;
      state.remote.network.restartRequired = false;
      result = { restarting: true, instanceId: "one" };
    } else if (path === "/settings/summary") result = state.summary;
    else if (path === "/health") result = state.health;
    else if (/\/sessions\/[^/]+\/github$/.test(path))
      result = { configured: true, hosts: [], remote: null };
    // Zugänge reads every category's list, usage and problems (connections specs
    // replace them with their own routes).
    else if (path === "/ssh-accesses" && method === "GET")
      result = { accesses: state.sshAccesses || [] };
    else if (path === "/ssh-keys" && method === "GET") result = { keys: [] };
    else if (path === "/ssh-projects" && method === "GET") result = { projects: [] };
    else if (path === "/mcp-servers" && method === "GET") result = [];
    else if (path === "/mcp-servers/cli-finds") result = { finds: [], problems: [] };
    else if (path === "/accounts/usage") result = {};
    else if (path === "/connections/usage") result = state.connectionUsage ?? null;
    else if (path === "/connections/problems")
      result = state.connectionProblems ?? connectionProblems(state.summary);
    // The Menü hints read the pipeline runs when the menu opens.
    else if (path === "/pipeline-runs" && method === "GET")
      result = { runs: [], total: 0, page: 1, pageSize: 20 };
    // Agents are off: the users page lists users without agents.
    else if (path === "/assistants" && method === "GET")
      return route.fulfill({ status: 503, json: { error: "Agents are off" } });
    // The new agent wizard reads the users and whether web search is set up.
    else if (path === "/users" && method === "GET") result = [];
    else if (path === "/assistant-web-search")
      result = { revision: 0, provider: "duckduckgo", ready: true };
    else throw Error(`Unexpected operations fixture request ${method} ${path}`);
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket("**/terminal", (socket) =>
    socket.send(JSON.stringify({ type: "status", status: "running" })),
  );
  await mockChatStream(page, () => chat);
  return state;
}
