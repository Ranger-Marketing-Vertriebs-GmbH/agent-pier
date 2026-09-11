import { expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
export async function pipelinesFixture(page) {
  const profile = {
    id: "profile-one",
    name: "Planer",
    description: "Projektplanung",
    enabled: true,
    phaseKey: "planning",
    revision: 1,
    config: {
      accountId: "local-codex",
      cliTool: "codex",
      models: { available: [""], default: "" },
      prompts: { role: "Inspect the project", kickoff: "Plan the task", params: [] },
      permissions: { mode: "never" },
      run: { autonomous: true },
    },
  };
  const pipeline = {
    id: "pipeline-one",
    name: "Entwicklungsablauf",
    description: "Plan and build",
    revision: 1,
    graph: {
      entry: "plan",
      nodes: [{ id: "plan", kind: "profile", profileId: profile.id }],
      edges: [],
    },
  };
  const state = {
    connections: [
      {
        id: "central-openrouter",
        name: "Zentraler Router",
        providerId: "openrouter",
        tools: ["codex", "claude"],
        hasSecret: true,
      },
      {
        id: "central-zai",
        name: "Z.ai nur Claude",
        providerId: "zai",
        tools: ["claude"],
        hasSecret: false,
      },
    ],
    profiles: [profile],
    pipelines: [pipeline],
    projects: [{ id: "project-one", name: "Projekt", cwd: "/fixture/project" }],
    runs: [],
    sessions: [],
    steps: [],
    calls: [],
    fail: "",
    hold: null,
    release: null,
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.replace("/api", ""),
      method = req.method(),
      body = ["GET", "DELETE"].includes(method) ? null : req.postDataJSON();
    state.calls.push({ path, method, body });
    if (state.hold === path) await new Promise((resolve) => (state.release = resolve));
    if (state.fail === path)
      return route.fulfill({
        status: 409,
        json: { error: "Fixture conflict: reload required" },
      });
    let result;
    if (path === "/state")
      result = {
        tools: [
          { id: "codex", name: "Codex", installed: true },
          { id: "claude", name: "Claude Code", installed: true },
        ],
        accounts: [
          { id: "local-codex", name: "Codex lokal", tool: "codex", kind: "local" },
          { id: "local-claude", name: "Claude lokal", tool: "claude", kind: "local" },
        ],
        sessions: state.sessions,
        providerConnections: state.connections,
        home: "/fixture",
      };
    else if (path === "/ssh-accesses") result = { accesses: [] };
    else if (path === "/provider-connections")
      result = { connections: state.connections };
    else if (path.startsWith("/providers/") && path.endsWith("/models"))
      result = {
        models: [
          {
            modelId: "fixture/model",
            label: "Fixture model",
            tools: ["codex", "claude"],
            contextTokens: 128000,
          },
        ],
        status: { source: "fixture", stale: false },
      };
    else if (path === "/memory/projects") {
      if (method === "POST") {
        const project = { id: "project-registered", name: "Registered", cwd: body.cwd };
        state.projects.push(project);
        result = project;
      } else result = { projects: state.projects };
    } else if (path.startsWith("/pipeline-verification/")) {
      if (method === "PUT") state.steps = body.steps;
      result = { projectId: "project-one", steps: state.steps };
    } else if (path.startsWith("/pipeline-profiles")) {
      const id = path.split("/")[2];
      if (path.endsWith("/stats")) result = { stageRunsLast7Days: 3 };
      else if (path.endsWith("/launch")) {
        const session = {
          id: "launched",
          name: "Profile session",
          tool: "codex",
          accountId: "local-codex",
          cwd: body.cwd,
          status: "running",
        };
        state.sessions.push(session);
        result = { session };
      } else if (method === "DELETE") {
        state.profiles = state.profiles.filter((p) => p.id !== id);
        result = {};
      } else if (method === "POST" || method === "PATCH") {
        const next = { ...body, id: id || "profile-new", revision: 2 };
        state.profiles = [...state.profiles.filter((p) => p.id !== next.id), next];
        result = { profile: next };
      } else
        result = id
          ? { profile: state.profiles.find((p) => p.id === id) }
          : { profiles: state.profiles };
    } else if (path.startsWith("/pipelines")) {
      const id = path.split("/")[2];
      if (method === "DELETE") {
        state.pipelines = state.pipelines.filter((p) => p.id !== id);
        result = {};
      } else if (method === "POST" || method === "PATCH") {
        const next = { ...body, id: id || "pipeline-new", revision: 2 };
        state.pipelines = [...state.pipelines.filter((p) => p.id !== next.id), next];
        result = { pipeline: next };
      } else
        result = id
          ? { pipeline: state.pipelines.find((p) => p.id === id) }
          : { pipelines: state.pipelines };
    } else if (path === "/pipeline-runs") {
      if (method === "POST") {
        const run = {
          id: "new-run",
          pipelineId: body.pipelineId,
          pipelineName: "Entwicklungsablauf",
          task: body.task,
          cwd: body.cwd,
          projectId: "project-one",
          status: "running",
          nodes: [],
          actions: ["abort"],
          usage: null,
        };
        state.runs.push(run);
        result = { run };
      } else {
        const filtered = state.runs.filter(
          (run) =>
            (!url.searchParams.get("projectId") ||
              run.projectId === url.searchParams.get("projectId")) &&
            (!url.searchParams.get("status") ||
              run.status === url.searchParams.get("status")),
        );
        const pageNumber = Number(url.searchParams.get("page") || 1);
        result = {
          runs: filtered.slice((pageNumber - 1) * 20, pageNumber * 20),
          total: filtered.length,
          page: pageNumber,
          pageSize: 20,
        };
      }
    } else if (path.startsWith("/pipeline-runs/")) {
      const id = path.split("/")[2],
        run = state.runs.find((run) => run.id === id);
      if (path.endsWith("/artifacts"))
        result = {
          artifacts: [
            {
              nodeId: "stage-one",
              artifacts: [{ path: "report.md", label: "Prüfbericht" }],
            },
          ],
        };
      else if (path.endsWith("/artifact"))
        result = { content: "Fixture report evidence", truncated: false };
      else if (path.endsWith("/diff"))
        result = { diff: "+new line\n-old line", truncated: true };
      else if (path.includes("/verify-logs/"))
        result = { log: "Fixture verification log", truncated: false };
      else if (path.endsWith("/verdict-status"))
        result = { present: true, result: "pass" };
      else if (method === "DELETE") {
        state.runs = state.runs.filter((run) => run.id !== id);
        result = {};
      } else if (method === "POST") {
        if (path.endsWith("/gate") && body.action === "feedback") {
          run.status = "running";
          run.actions = ["abort"];
        } else if (path.endsWith("/cancel")) {
          run.status = "cancelled";
          run.actions = ["delete"];
        }
        result = { run };
      } else result = { run };
    } else if (path.endsWith("/models"))
      result = { currentModel: null, picker: null, pending: false };
    else if (path.endsWith("/chat"))
      result = { messages: [], tasks: [], availability: "ready" };
    else throw Error(`Unexpected pipeline fixture request ${method} ${path}`);
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket("**/terminal", (socket) =>
    socket.send(JSON.stringify({ type: "status", status: "running" })),
  );
  return state;
}
export async function openPipelines(page, path = "profiles") {
  await page.goto(baseURL + "/pipelines/" + path);
  await expect(
    page.getByRole("heading", { name: "Pipelines", exact: true }),
  ).toBeVisible();
}
