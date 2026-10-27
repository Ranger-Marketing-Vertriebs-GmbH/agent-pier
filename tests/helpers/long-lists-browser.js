import { longListAgents, longListSessions } from "../fixtures/long-lists.js";
import { systemStatusAnswer } from "./system-status-fixture.js";

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

// Two decisions in the Inbox: a pipeline gate and a Claude approval.
const inboxItems = () => [
  {
    type: "gate",
    id: "run-deps",
    tab: "gates",
    kind: "gate",
    source: { kind: "run", id: "run-deps", name: "Dependency-Update" },
    title: "Risk-Gate: japanischa · Dependency-Update",
    createdAt: minutesAgo(12),
    expiresAt: null,
    link: "/pipelines/runs/run-deps",
  },
  {
    type: "approval",
    id: "permit-review",
    tab: "approvals",
    kind: "permission",
    source: { kind: "session", id: "long-migration-pr-fen", name: "Migration prüfen" },
    title: "Code-Review möchte in hoppkit-api schreiben",
    createdAt: minutesAgo(4),
    expiresAt: null,
    link: "/sessions/long-migration-pr-fen/chat",
  },
];

const stage = (id, status) => ({ id, status, profileSnapshot: { name: id } });
// A running, an awaiting and a failed run for the pipelines card.
const runs = {
  running: {
    id: "run-offline",
    status: "running",
    pipelineName: "Feature",
    task: "Offline-Karten",
    cwd: "/work/hoppkit-api",
    createdAt: minutesAgo(18),
    currentNodeId: "Verifikation",
    nodes: [
      stage("Plan", "passed"),
      stage("Bauen", "passed"),
      stage("Verifikation", "running"),
      stage("Review", "pending"),
      stage("Merge", "pending"),
    ],
  },
  "awaiting-human": {
    id: "run-deps",
    status: "awaiting-human",
    pipelineName: "Dependencies",
    task: "Dependency-Update",
    cwd: "/work/japanischa",
    createdAt: minutesAgo(30),
    currentNodeId: "Risk-Gate",
    nodes: [
      stage("Update", "passed"),
      stage("Tests", "passed"),
      stage("Risk-Gate", "awaiting-gate"),
    ],
  },
  failed: {
    id: "run-lint",
    status: "failed",
    pipelineName: "Fix",
    task: "Lint-Fix",
    cwd: "/work/agent-pier",
    createdAt: minutesAgo(60),
    currentNodeId: "Tests",
    nodes: [stage("Fix", "passed"), stage("Tests", "failed"), stage("Review", "pending")],
  },
};

/** The start page's figures: every running session's CPU and RAM, by id. */
function sessionFigures(sessions) {
  return sessions
    .filter((session) => session.status === "running")
    .map((session, index) => ({
      id: session.id,
      cpuPercent: ((index * 7) % 50) / 10,
      rssBytes: (200 + index * 17) * 1024 ** 2,
    }));
}

// Serves the long-list host (tests/fixtures/long-lists.js) to the app: 24 sessions in
// /api/state and, with `agents`, 14 agents, two Inbox items and three pipeline runs.
// Every write is recorded and refused, so a spec can assert that browsing never
// changes anything. The returned `sessions` and `agents` are live: a spec may change
// them before the next poll. The agents' event stream ends after "connected".
export async function serveLongLists(page, { agents = true, language } = {}) {
  if (language)
    await page.addInitScript(
      (value) => localStorage.setItem("agentpier-language", value),
      language,
    );
  const sessions = longListSessions();
  const agentData = longListAgents();
  const writes = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { error: "read-only fixture" } });
    }
    if (path === "/api/system-status") {
      const status = systemStatusAnswer(path);
      return route.fulfill({ json: { ...status, sessions: sessionFigures(sessions) } });
    }
    const status = systemStatusAnswer(path);
    if (status) return route.fulfill({ json: status });
    if (path === "/api/state")
      return route.fulfill({
        json: {
          tools: ["codex", "claude", "opencode", "shell"].map((id) => ({
            id,
            name: {
              codex: "Codex",
              claude: "Claude Code",
              opencode: "OpenCode",
              shell: "Shell",
            }[id],
            installed: true,
            version: id === "shell" ? undefined : "1.0.0",
            minimumVersion: id === "shell" ? undefined : "1.0.0",
            versionStatus: "ok",
          })),
          utilities: [],
          accounts: ["codex", "claude", "opencode", "shell"].map((tool) => ({
            id: `local-${tool}`,
            tool,
            name: "Lokal",
            kind: "local",
          })),
          sessions,
          home: "/work",
          inbox: {
            instance: "long",
            revision: 1,
            counts: { all: 2, questions: 0, approvals: 1, gates: 1, agents: 0 },
          },
        },
      });
    if (path === "/api/inbox")
      return route.fulfill({
        json: {
          instance: "long",
          revision: 1,
          counts: { all: 2, questions: 0, approvals: 1, gates: 1, agents: 0 },
          items: inboxItems(),
        },
      });
    if (path === "/api/assistant-feature")
      return route.fulfill({ json: { enabled: agents, error: null } });
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path === "/api/assistants") return route.fulfill({ json: agentData });
    if (path === "/api/pipeline-runs") {
      const run = runs[url.searchParams.get("status")];
      return route.fulfill({
        json: { runs: run ? [run] : [], total: run ? 1 : 0, page: 1, pageSize: 20 },
      });
    }
    if (["/api/users", "/api/mcp-servers"].includes(path))
      return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (ws) =>
    ws.send(JSON.stringify({ type: "output", data: "Fixture" })),
  );
  return { sessions, agents: agentData, writes };
}
