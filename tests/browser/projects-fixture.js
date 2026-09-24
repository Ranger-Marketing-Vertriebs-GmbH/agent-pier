export const repositoryPath = "/work/agent-pier";

export const hubRun = (id, projectId, status) => ({
  id,
  projectId,
  status,
  pipelineName: "Entwicklungsablauf",
  task: `Task ${id}`,
  cwd: projectId === "m1" ? repositoryPath : "/work/notes",
  createdAt: "2026-09-10T05:00:00Z",
  nodes: [{ id: "n1", status: "pending", profileSnapshot: { name: "Planer" } }],
  currentNodeId: "n1",
  actions: [],
});
const hubRuns = [
  hubRun("a", "m1", "awaiting-human"),
  hubRun("r2", "m1", "running"),
  hubRun("r3", "m1", "completed"),
  hubRun("f1", "m2", "failed"),
  hubRun("f2", "m2", "failed"),
];

export async function hubFixture(page, controls = {}) {
  const calls = [];
  const memoryProjects = [
    {
      id: "m1",
      name: "agent-pier",
      cwd: repositoryPath,
      kind: "repository",
      entryCount: 4,
    },
    { id: "m2", name: "notes", cwd: "/work/notes", kind: "directory", entryCount: 0 },
  ];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    calls.push({ method, path: url.pathname, search: url.search });
    // A test can answer any request itself; it returns true once it has.
    if (await controls.intercept?.(route, url, method)) return;
    let json = {};
    if (controls.failMemory && url.pathname === "/api/memory/projects")
      return route.fulfill({ status: 503, json: { error: "Wissen nicht erreichbar" } });
    if (url.pathname === "/api/state")
      json = {
        tools: [{ id: "codex", name: "Codex", installed: true }],
        accounts: [{ id: "local-codex", name: "Lokal", tool: "codex", kind: "local" }],
        sessions: [
          {
            id: "s1",
            name: "Hub fixture session",
            tool: "codex",
            accountId: "local-codex",
            cwd: `${repositoryPath}/`,
            status: "running",
            createdAt: new Date(Date.now() - 5 * 60000).toISOString(),
          },
        ],
        home: "/work",
      };
    else if (url.pathname === "/api/repositories")
      json = {
        credentials: [
          { id: "c1", name: "Arbeit", host: "https://github.com", hasSecret: true },
        ],
        projects: [
          ...(controls.unregistered
            ? [{ id: "r2", name: "loose", url: "", path: "/work/loose" }]
            : []),
          {
            id: "r1",
            name: "agent-pier",
            url: "https://github.com/acme/agent-pier.git",
            path: repositoryPath,
            credentialId: "c1",
          },
        ],
      };
    else if (url.pathname === "/api/memory/projects" && method === "POST") {
      const body = request.postDataJSON();
      const added = {
        id: "m3",
        name: "added",
        cwd: body.cwd,
        kind: "directory",
        entryCount: 0,
      };
      memoryProjects.push(added);
      json = added;
    } else if (url.pathname === "/api/memory/projects")
      json = { projects: memoryProjects };
    else if (url.pathname === "/api/agentbus")
      json = {
        version: "test",
        projects: [
          {
            id: "b1",
            name: "agent-pier",
            cwd: repositoryPath,
            sessions: [{ id: "s1", name: "Hub fixture session", tool: "codex" }],
          },
        ],
      };
    else if (url.pathname.endsWith("/entries"))
      json = { projectId: "m1", items: [], page: 1, pageSize: 20, total: 0 };
    else if (url.pathname === "/api/repositories/discover")
      json = {
        organizations: [],
        repositories: [],
        total: 0,
        page: 1,
        hasMore: false,
        truncated: false,
      };
    else if (url.pathname === "/api/pipeline-runs" && method === "POST")
      json = { run: { id: "new-run", ...request.postDataJSON() } };
    else if (url.pathname === "/api/pipeline-runs") {
      const status = url.searchParams.get("status"),
        projectId = url.searchParams.get("projectId"),
        page = Number(url.searchParams.get("page") || 1);
      const runs = (controls.runs || hubRuns).filter(
        (run) =>
          (!status || run.status === status) &&
          (!projectId || run.projectId === projectId),
      );
      json = {
        runs: runs.slice((page - 1) * 20, page * 20),
        total: runs.length,
        page,
        pageSize: 20,
      };
    } else if (url.pathname.startsWith("/api/pipeline-runs/"))
      json = { run: hubRuns.find((run) => url.pathname.endsWith(`/${run.id}`)) };
    else if (url.pathname === "/api/pipelines")
      json = { pipelines: [{ id: "p1", name: "Entwicklungsablauf" }] };
    await route.fulfill({ json });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", () => {});
  return calls;
}
