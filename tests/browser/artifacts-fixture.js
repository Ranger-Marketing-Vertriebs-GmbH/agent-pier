// A mocked Artifacts API for the page specs: filters, counts, pins and deletion behave
// like the server (tests/blackbox/artifact-routes.test.js covers the real one).
export const now = new Date("2026-10-13T12:00:00+02:00");

const minutes = (count) => new Date(now.getTime() - count * 60000).toISOString();

export const sessions = [
  {
    id: "s1",
    name: "Settings redesign QA",
    tool: "claude",
    cwd: "/fixture/agent-pier",
    status: "stopped",
  },
  {
    id: "s2",
    name: "Checkout flow polish",
    tool: "codex",
    cwd: "/fixture/shop",
    status: "running",
  },
];
export const projects = [
  { id: "p1", name: "agent-pier" },
  { id: "p2", name: "shop-frontend" },
];

export function artifactItems() {
  return [
    {
      id: "a1",
      title: "Settings QA report",
      sessionId: "s1",
      projectId: "p1",
      mediaType: "text/html",
      sizeBytes: 2.3 * 1024 * 1024,
      fileCount: 3,
      createdAt: minutes(115),
      updatedAt: minutes(18),
      pinned: false,
      orphaned: false,
    },
    {
      id: "a2",
      title: "Checkout screenshots",
      sessionId: "s2",
      projectId: "p2",
      mediaType: "image/png",
      sizeBytes: 840000,
      fileCount: 1,
      createdAt: minutes(165),
      updatedAt: minutes(165),
      pinned: false,
      orphaned: false,
    },
    {
      id: "a3",
      title: "Release notes preview",
      sessionId: "s1",
      projectId: "p1",
      mediaType: "text/html",
      sizeBytes: 120000,
      fileCount: 1,
      createdAt: minutes(18 * 60),
      updatedAt: minutes(18 * 60),
      pinned: true,
      orphaned: false,
    },
    {
      id: "a4",
      title: "Dependency upgrade summary",
      sessionId: "s9",
      projectId: "p1",
      mediaType: "text/html",
      sizeBytes: 310000,
      fileCount: 1,
      createdAt: minutes(14 * 1440),
      updatedAt: minutes(14 * 1440),
      pinned: true,
      orphaned: true,
    },
  ];
}

const page = Buffer.from(
  '<link rel="stylesheet" href="style.css"><h1>Private report</h1>' +
    '<script>document.body.append("SCRIPT RAN")</script>',
).toString("base64");
const style = Buffer.from("h1 { color: rgb(1, 2, 3); }").toString("base64");
// A 1×1 PNG.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function bundle(item) {
  return item.mediaType === "text/html"
    ? {
        artifact: item,
        entrypoint: "index.html",
        files: [
          { path: "index.html", mediaType: "text/html", base64: page },
          { path: "style.css", mediaType: "text/css", base64: style },
        ],
      }
    : {
        artifact: item,
        entrypoint: "shot.png",
        files: [{ path: "shot.png", mediaType: "image/png", base64: png }],
      };
}

/** Routes the app's API; `state.items` is the live artifact list. */
export async function artifactsFixture(context, { language = "en", items } = {}) {
  const state = { items: items ?? artifactItems(), requests: [] };
  await context.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    const match = /^\/api\/artifacts\/([^/]+)(\/bundle)?$/.exec(pathname);
    if (pathname === "/api/state")
      return route.fulfill({
        json: {
          tools: [
            { id: "claude", name: "Claude Code", installed: true },
            { id: "codex", name: "Codex", installed: true },
          ],
          accounts: [],
          home: "/fixture",
          sessions,
        },
      });
    if (pathname === "/api/memory/projects") return route.fulfill({ json: { projects } });
    if (pathname === "/api/artifacts/usage")
      return route.fulfill({
        json: {
          usedBytes: 9.2 * 1024 * 1024,
          pendingCleanupBytes: 0,
          limitBytes: 1024 ** 3,
        },
      });
    if (pathname === "/api/artifacts") {
      state.requests.push(url.search);
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const projectId = url.searchParams.get("projectId");
      const names = (item) => [
        item.title,
        sessions.find((entry) => entry.id === item.sessionId)?.name || "",
        projects.find((entry) => entry.id === item.projectId)?.name || "",
      ];
      const matching = state.items.filter(
        (item) =>
          (!projectId || item.projectId === projectId) &&
          (!q || names(item).some((name) => name.toLowerCase().includes(q))),
      );
      const shown =
        url.searchParams.get("pinned") === "true"
          ? matching.filter((item) => item.pinned)
          : matching;
      return route.fulfill({
        json: {
          items: shown,
          page: 1,
          total: shown.length,
          counts: {
            all: matching.length,
            pinned: matching.filter((item) => item.pinned).length,
          },
        },
      });
    }
    if (match) {
      const item = state.items.find((entry) => entry.id === match[1]);
      if (!item)
        return route.fulfill({ status: 404, json: { code: "ARTIFACT_NOT_FOUND" } });
      if (match[2]) return route.fulfill({ json: bundle(item) });
      if (method === "DELETE") {
        state.items = state.items.filter((entry) => entry !== item);
        return route.fulfill({ status: 204, body: "" });
      }
      if (method === "PATCH") {
        const { pinned } = request.postDataJSON();
        if (!pinned && item.orphaned) {
          state.items = state.items.filter((entry) => entry !== item);
          return route.fulfill({ json: null });
        }
        item.pinned = pinned;
        return route.fulfill({ json: item });
      }
      return route.fulfill({ json: item });
    }
    return route.fulfill({ json: {} });
  });
  return state;
}
