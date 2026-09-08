import { operationState, operationResponse } from "./operations-http-fixture.js";
export async function operationsFixture(page) {
  const state = {
    ...operationState(),
    calls: [],
    fail: "",
    hold: "",
    release: null,
    requests: [],
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
    let result;
    if (path === "/state")
      result = {
        tools: [{ id: "codex", name: "Codex", installed: true }],
        accounts: [
          { id: "local-codex", tool: "codex", kind: "local", name: "Codex lokal" },
        ],
        sessions: [
          {
            id: "fixture-session",
            name: "Fixture session",
            tool: "codex",
            accountId: "local-codex",
            status: "running",
            cwd: "/fixture",
            nativeRequests: { enabled: true, version: 1 },
          },
        ],
        home: "/fixture",
        defaultCwd: "/fixture",
      };
    else if (path === "/notifications")
      result = { enabled: true, publicKey: "AQIDBA", subscriptions: [] };
    else if (path === "/preferences") result = body;
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
    else if (path.endsWith("/requests")) result = { requests: state.requests };
    else if (/\/requests\/[^/]+\/(answer|handoff)$/.test(path)) {
      state.requests = [];
      result = { requests: [] };
    } else if (path.endsWith("/chat"))
      result = { messages: [], tasks: [], availability: "ready" };
    else if (path.endsWith("/models"))
      result = { currentModel: null, picker: null, pending: false };
    else throw Error(`Unexpected operations fixture request ${method} ${path}`);
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket("**/terminal", (socket) =>
    socket.send(JSON.stringify({ type: "status", status: "running" })),
  );
  return state;
}
