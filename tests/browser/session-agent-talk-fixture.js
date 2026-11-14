import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// Sessions and agents talking to each other (docs/session-agent-talk.md) on stubbed
// routes: the agent chat of chatFixture, the agent "Network Architect" with the
// project "Homelab", two running Codex sessions (one launched without AgentPier tools)
// and the agent access routes. The live stub answers `session.agent-access:<id>` from
// the GET route below. `state` records the PUTs, launches and access saves.
export const architect = { id: "architect", name: "Network Architect" };
export const planner = { id: "planner", name: "Planner" };
export const project = { id: "homelab", name: "Homelab", path: "/work/homelab" };

const agentRow = (agent) => ({
  ...agent,
  instructions: "Plan the network",
  model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
  capabilities: { memory: true },
  revision: 1,
  effectiveRevision: 1,
});

export const deploySession = {
  id: "deploy",
  name: "Homelab deploy",
  accountId: "local-codex",
  tool: "codex",
  status: "running",
  cwd: "/work/homelab",
  createdAt: "2026-11-13T10:00:00.000Z",
};
export const bareSession = {
  id: "bare",
  name: "Bare shell work",
  accountId: "local-codex",
  tool: "codex",
  status: "running",
  cwd: "/work/homelab",
  createdAt: "2026-11-13T10:05:00.000Z",
};

export async function talkFixture(page, options = {}) {
  const ask = "give me a free IP";
  const now = Date.now();
  const state = await chatFixture(page, {
    assistants: [agentRow(architect), agentRow(planner)],
    conversations: [{ id: "dinner", assistantId: "architect" }],
    history: {
      messages: [
        {
          id: "ask",
          role: "user",
          text: ask,
          timestamp: now - 60000,
          source: "session",
          sender: {
            kind: "session",
            name: "Homelab deploy",
            project: "homelab",
            op: "ask",
          },
        },
        {
          id: "answer",
          role: "assistant",
          text: "10.0.0.42 is free.",
          timestamp: now - 50000,
        },
        {
          id: "session-talk:send-1",
          role: "event",
          event: "session-talk",
          op: "send",
          sessionName: "Homelab deploy",
          projectName: "homelab",
          text: "10.0.0.42 is reserved for you",
          outcome: "accepted",
          timestamp: now - 40000,
          runId: null,
        },
      ],
      requests: [],
      stale: false,
    },
    ...options,
  });
  Object.assign(state, {
    sessions: [deploySession, bareSession],
    // The session's own grant and the agents its project lets talk.
    assigned: { deploy: [], bare: [] },
    inherited: { deploy: [architect.id], bare: [] },
    tools: { deploy: "ready", bare: "missing" },
    accessPuts: [],
    launches: [],
    saves: [],
    policy: {
      revision: 3,
      projectIds: [project.id],
      projectFiles: {},
      sessionProjectIds: [project.id],
      talkProjectIds: [],
      pipelineIds: [],
      memoryWrite: false,
      autonomous: false,
      publish: false,
      sshAccesses: [],
    },
  });
  const choices = [architect, planner].map(({ id, name }) => ({ id, name }));
  const access = (id) => ({
    agents: choices,
    assignedIds: state.assigned[id],
    inheritedIds: state.inherited[id],
    tools: state.tools[id],
  });
  // ⌘K's own reads, empty.
  const empty = {
    "/api/repositories": { repositories: [] },
    "/api/memory/projects": { projects: [] },
    "/api/pipelines": { pipelines: [] },
    "/api/pipeline-runs": { runs: [], total: 0, page: 1, pageSize: 20 },
    "/api/inbox": { instance: "fixture", revision: 1, items: [], counts: { all: 0 } },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      method = request.method(),
      path = new URL(request.url()).pathname;
    if (Object.hasOwn(empty, path)) return route.fulfill({ json: empty[path] });
    if (path === "/api/state")
      return route.fulfill({
        json: {
          home: "/work",
          tools: ["codex", "claude", "opencode"].map((id) => ({
            id,
            name: id,
            installed: true,
          })),
          accounts: [{ id: "local-codex", tool: "codex", kind: "local", name: "Codex" }],
          sessions: state.sessions,
          providerConnections: [],
        },
      });
    const grant = path.match(/^\/api\/sessions\/([^/]+)\/agent-accesses$/);
    if (grant) {
      const id = decodeURIComponent(grant[1]);
      if (method === "PUT") {
        const body = request.postDataJSON();
        state.accessPuts.push({ id, body });
        state.assigned[id] = body.assistantIds;
      }
      return route.fulfill({ json: access(id) });
    }
    if (path === "/api/session-talk/agents")
      return route.fulfill({ json: { agents: choices } });
    if (path === "/api/sessions" && method === "POST") {
      state.launches.push(request.postDataJSON());
      return route.fulfill({ status: 409, json: { error: "Launch rejected" } });
    }
    if (path === "/api/assistant-workspace-catalog")
      return route.fulfill({
        json: { projects: [project], pipelines: [], sshHosts: [] },
      });
    if (/^\/api\/assistants\/[^/]+\/access$/.test(path))
      return route.fulfill({ json: state.policy });
    if (/^\/api\/assistants\/[^/]+\/work$/.test(path) && method === "PUT") {
      const input = request.postDataJSON();
      state.saves.push(input.access);
      state.policy = {
        ...state.policy,
        ...input.access,
        revision: state.policy.revision + 1,
      };
      return route.fulfill({
        json: {
          access: state.policy,
          team: { revision: 0, autonomous: false, maxMembers: 4, runTimeoutMinutes: 10 },
          removedProjectIds: [],
        },
      });
    }
    return route.fallback();
  });
  await page.routeWebSocket("**/terminal", (socket) => {
    socket.send(JSON.stringify({ type: "status", status: "running" }));
  });
  return state;
}
