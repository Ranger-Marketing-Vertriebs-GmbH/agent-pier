import { mockChatStream } from "../helpers/chat-stream-fixture.js";

// The owner's inbox with one item of every source: a CLI question (session alpha), a
// CLI approval (session beta), a pipeline gate, an agent's shell command and a team
// proposal. Answers go to each source's own endpoint and remove the item, as the
// server would; the inbox list then reports a new revision.
const created = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

export async function inboxFixture(page, { language, agents = true } = {}) {
  if (language)
    await page.addInitScript(
      (value) => localStorage.setItem("agentpier-language", value),
      language,
    );
  const requests = {
    alpha: [
      {
        id: "ask-alpha",
        sessionId: "alpha",
        kind: "question",
        revision: 1,
        status: "pending",
        source: "codex",
        createdAt: created(30),
        questions: [
          {
            id: "q1",
            prompt: "Which framework should the app use?",
            header: "Framework",
            options: [
              { id: "react", label: "React" },
              { id: "vue", label: "Vue" },
            ],
            multiple: false,
            allowOther: false,
          },
        ],
      },
    ],
    beta: [
      {
        id: "permit-beta",
        sessionId: "beta",
        kind: "permission",
        revision: 1,
        status: "pending",
        source: "claude",
        createdAt: created(20),
        subject: { tool: "Bash", command: "npm test" },
        options: [
          // The server's German fallback labels; chat translates Claude options by ID.
          { id: "allow", label: "Einmal erlauben", scope: "once" },
          { id: "deny", label: "Ablehnen" },
        ],
      },
    ],
  };
  const run = {
    id: "run-one",
    status: "awaiting-human",
    pipelineName: "Ship it",
    task: "Release the new version",
    currentNodeId: "review",
    nodes: [
      { id: "review", status: "awaiting-gate", profileSnapshot: { name: "Review" } },
    ],
    executionLog: [],
    actions: ["accept", "feedback", "replace-spec", "abort"],
    // The stage at the gate wrote the run's spec; the gate shows it.
    spec: {
      path: ".pipeline/reports/review/attempt-1/spec.md",
      nodeId: "review",
      source: "stage",
      frozen: false,
      text: "# Spec\n\n## Acceptance criteria\n1. The release notes are published.\n",
      criteria: [{ id: "AC1", text: "The release notes are published." }],
      assumptions: [],
    },
  };
  const exec = {
    id: "exec-one",
    assistantId: "helper",
    revision: 1,
    state: "awaiting_approval",
    createdAt: created(5),
    expiresAt: Date.now() + 4 * 60000,
    payload: {
      action: "exec",
      command: "ls -la",
      cwd: "/fixture",
      approvalId: "one",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    allowAlwaysByAgentPier: false,
  };
  const proposal = {
    id: "proposal-one",
    kind: "team",
    parentAssistantId: "helper",
    objective: "Review the release",
    phase: "awaiting_approval",
    members: [{ name: "Ada", role: "Reviewer", assignment: "Read the diff", grants: {} }],
    revision: 1,
  };
  const items = [
    {
      type: "action",
      tab: "agents",
      id: exec.id,
      kind: "exec",
      status: "awaiting_approval",
      source: { kind: "agent", id: "helper", name: "Helper" },
      title: "",
      createdAt: exec.createdAt,
      expiresAt: new Date(exec.expiresAt).toISOString(),
      link: "/agents/helper/chats/chat-1",
    },
    {
      type: "gate",
      tab: "gates",
      id: run.id,
      kind: "gate",
      status: "awaiting-human",
      source: { kind: "pipeline", id: run.id, name: "Ship it", project: "app" },
      title: "Review",
      createdAt: created(60),
      expiresAt: null,
      link: "/pipelines/runs/run-one",
    },
    {
      type: "question",
      tab: "questions",
      id: "ask-alpha",
      kind: "question",
      status: "pending",
      source: { kind: "session", id: "alpha", name: "Session alpha", tool: "codex" },
      title: "Framework",
      createdAt: created(30),
      expiresAt: null,
      link: "/sessions/alpha/chat",
    },
    {
      type: "approval",
      tab: "approvals",
      id: "permit-beta",
      kind: "permission",
      status: "pending",
      source: { kind: "session", id: "beta", name: "Session beta", tool: "claude" },
      title: "Bash",
      createdAt: created(20),
      expiresAt: null,
      link: "/sessions/beta/chat",
    },
    {
      type: "team",
      tab: "agents",
      id: proposal.id,
      kind: "proposal",
      status: "awaiting_approval",
      source: { kind: "agent", id: "helper", name: "Helper" },
      title: proposal.objective,
      members: 1,
      createdAt: created(10),
      expiresAt: null,
      link: "/agents/helper/chats/chat-1",
    },
  ];
  const state = { items, revision: 1, calls: [], done: {} };
  const counts = () => {
    const result = {
      all: state.items.length,
      questions: 0,
      approvals: 0,
      gates: 0,
      agents: 0,
    };
    for (const item of state.items) result[item.tab]++;
    return result;
  };
  const summary = () => ({
    instance: "fixture",
    revision: state.revision,
    counts: counts(),
  });
  const finish = (type, id, decision) => {
    state.items = state.items.filter((i) => !(i.type === type && i.id === id));
    state.done[`${type}:${id}`] = decision;
    state.revision++;
  };
  const session = (id) => ({
    id,
    name: `Session ${id}`,
    tool: id === "alpha" ? "codex" : "claude",
    accountId: "local",
    status: "running",
    cwd: "/fixture",
    activity: { state: "waiting" },
    nativeRequests: { enabled: true, version: 1 },
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.slice(4),
      method = request.method(),
      body = method === "POST" ? request.postDataJSON() : null;
    state.calls.push({ path, method, body });
    let result = {};
    if (path === "/assistant-feature") result = { enabled: agents, error: null };
    else if (path === "/assistant-events" || path === "/inbox/events")
      return route.fulfill({
        contentType: "text/event-stream",
        body:
          path === "/inbox/events"
            ? `retry: 600000\ndata: ${JSON.stringify({ type: "connected", ...summary() })}\n\n`
            : 'data: {"type":"connected"}\n\n',
      });
    else if (path === "/state")
      result = {
        tools: [
          { id: "codex", name: "codex", installed: true },
          { id: "claude", name: "claude", installed: true },
        ],
        accounts: [{ id: "local", tool: "codex", kind: "local", name: "Local" }],
        sessions: [session("alpha"), session("beta")],
        home: "/fixture",
        defaultCwd: "/fixture",
        inbox: summary(),
      };
    else if (path === "/inbox") result = { ...summary(), items: state.items };
    else if (/^\/inbox\/[^/]+\/[^/]+$/.test(path)) {
      const [, , type, id] = path.split("/");
      const decision = state.done[`${type}:${id}`];
      result = decision
        ? { state: "done", outcome: "answered", at: new Date().toISOString(), decision }
        : { state: "gone" };
    } else if (/^\/sessions\/(alpha|beta)\/requests$/.test(path))
      result = { requests: requests[path.split("/")[2]] };
    else if (/\/requests\/[^/]+\/answer$/.test(path)) {
      const [, , sessionId, , id] = path.split("/");
      requests[sessionId] = requests[sessionId].filter((r) => r.id !== id);
      finish(sessionId === "alpha" ? "question" : "approval", id, "allow");
      result = { requests: requests[sessionId] };
    } else if (/\/requests\/[^/]+\/touch$/.test(path)) result = {};
    else if (path === "/pipeline-runs/run-one") result = { run };
    else if (path === "/pipeline-runs/run-one/gate") {
      run.status = "running";
      finish("gate", run.id, "approve");
      result = { run };
    } else if (path === "/assistants")
      result = {
        assistants: [
          {
            id: "helper",
            name: "Helper",
            model: { connectionId: "router", modelId: "fixture-model" },
            revision: 1,
            effectiveRevision: 1,
          },
        ],
        conversations: [{ id: "chat-1", assistantId: "helper" }],
        models: [],
        teams: [proposal],
        members: [],
        policies: {},
      };
    else if (path === "/assistant-runtime")
      result = { availability: "ready", sync: "current" };
    else if (path === "/assistants/helper/actions")
      result = { actions: exec.state === "awaiting_approval" ? [exec] : [] };
    else if (path === "/assistant-actions/exec-one/decision") {
      exec.state = "completed";
      finish("action", exec.id, body.decision);
      result = exec;
    } else if (path === "/assistant-team-proposals/proposal-one/decision") {
      proposal.phase = body.decision === "approve" ? "approved" : "declined";
      finish("team", proposal.id, body.decision);
      result = proposal;
    } else if (path === "/mcp-servers") result = [];
    else if (path === "/mcp-servers/cli-finds") result = { finds: [], problems: [] };
    else if (path.endsWith("/chat"))
      result = { messages: [], tasks: [], availability: "ready" };
    else if (path.endsWith("/models"))
      result = { currentModel: null, picker: null, pending: false };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket("**/terminal", (socket) =>
    socket.send(JSON.stringify({ type: "status", status: "running" })),
  );
  await mockChatStream(page, () => ({ messages: [], tasks: [], availability: "ready" }));
  return state;
}
