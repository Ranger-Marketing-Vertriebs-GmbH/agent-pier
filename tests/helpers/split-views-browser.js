// A split view fixture for browser specs: two running sessions (s1 "Refactor billing",
// claude; s2 "Shop UI", codex), the agent a1 "Home assistant" with its main chat c1,
// and a stateful `/api/views` that applies writes to an in-test list and records them.
import { chatAssistant, chatFixture } from "./assistant-chat-fixture.js";

export const viewId = "v_0123456789abcdef";
export const leaf = {
  s1: (tab = "terminal") => ({ type: "pane", item: { kind: "session", id: "s1" }, tab }),
  s2: (tab = "terminal") => ({ type: "pane", item: { kind: "session", id: "s2" }, tab }),
  c1: () => ({
    type: "pane",
    item: { kind: "chat", assistantId: "a1", conversationId: "c1" },
  }),
};
export const split = (dir, a, b, ratio = 0.5) => ({ type: "split", dir, ratio, a, b });
// row(s1 terminal, col(s2 files, c1))
export const threePanes = () =>
  split("row", leaf.s1(), split("col", leaf.s2("files"), leaf.c1()));

export const sessions = {
  s1: {
    id: "s1",
    name: "Refactor billing",
    tool: "claude",
    cwd: "/fixture/billing",
    status: "running",
  },
  s2: {
    id: "s2",
    name: "Shop UI",
    tool: "codex",
    cwd: "/fixture/shop",
    status: "running",
  },
};

export const copy = {
  en: {
    removed: "Session removed",
    removeStale: "Remove from view",
    removePane: (name) => `Remove ${name} from the view`,
    nameLabel: "View name",
    notFound: "Page not found",
    narrowNote: /Panes side by side need a window wider than 1150 px/,
    open: "Open in editor",
    editor: (path) => `Document content: ${path}`,
    unsaved: "Save changes?",
    cancel: "Cancel",
    settings: "Settings",
    disconnected: "Disconnected",
    deleteView: "Delete view",
    retry: "Try again",
  },
  de: {
    removed: "Session entfernt",
    removeStale: "Aus der Ansicht nehmen",
    removePane: (name) => `${name} aus der Ansicht nehmen`,
    nameLabel: "Name der Ansicht",
    notFound: "Seite nicht gefunden",
    narrowNote: /Mehrere Bereiche nebeneinander gibt es ab 1151 px/,
    open: "Im Editor öffnen",
    editor: (path) => `Dokumentinhalt: ${path}`,
    unsaved: "Änderungen speichern?",
    cancel: "Abbrechen",
    settings: "Einstellungen",
    disconnected: "Getrennt",
    deleteView: "Ansicht löschen",
    retry: "Erneut versuchen",
  },
};

const fileEntry = (name) => ({
  name,
  path: name,
  type: "file",
  size: 8,
  modifiedAt: "2026-11-01T10:00:00.000Z",
  mode: 0o600,
  readable: true,
  writable: true,
  linkTarget: null,
  revision: "e1:fixture",
});

// A session's file explorer with one file, readme.txt, that opens in the editor.
function explorerAnswer(session, rest, url) {
  const file = url.searchParams.get("path") || "";
  if (rest === "/context")
    return {
      scopeId: `f1:${session.cwd}`,
      kind: "project",
      root: session.cwd,
      home: "/fixture",
      readOnly: false,
      limits: { listPageSize: 200, listEntries: 100000 },
    };
  if (rest === "/jobs") return { jobs: [], nextCursor: null };
  if (rest === "/preferences") return { favorites: [], showHidden: false };
  if (rest === "/entries")
    return {
      path: file,
      parent: null,
      entries: [fileEntry("readme.txt")],
      total: 1,
      page: 1,
      pageSize: 200,
      hasMore: false,
      snapshotId: `snapshot-${session.id}`,
    };
  if (rest === "/metadata")
    return url.searchParams.get("view") === "document"
      ? { path: file, resolvedPath: file, metadataRevision: `e1:${"1".repeat(64)}` }
      : fileEntry(file.split("/").at(-1));
  if (rest === "/preview") return { type: "text", text: "original", path: file };
  if (rest === "/text")
    return {
      path: file,
      resolvedPath: file,
      text: "original",
      bom: false,
      lineEnding: "lf",
      revision: `d1:${"1".repeat(64)}`,
      metadataRevision: `e1:${"1".repeat(64)}`,
      readOnly: false,
    };
  return {};
}

/**
 * Mocks the app for a split view (`views` replaces the one default view); returns the
 * controls: `views` (the stored list; `POST /api/views` adds to it, refused from 30),
 * `writes` ({ method, id?, body } per view write), `sessionPosts` (POST paths under
 * /api/sessions), `presence` (REST presence reports) and `sessions` (shown in
 * /api/state; replace it to drop a session).
 */
export async function splitViewFixture(page, { language = "en", layout, views } = {}) {
  await chatFixture(page, {
    language,
    assistants: [chatAssistant({ id: "a1" })],
    conversations: [{ id: "c1", assistantId: "a1" }],
  });
  const at = "2026-11-01T10:00:00.000Z";
  const controls = {
    version: 1,
    views: views ?? [
      {
        id: viewId,
        name: "Design review",
        layout: layout === undefined ? threePanes() : layout,
        revision: 1,
        createdAt: at,
        usedAt: at,
      },
    ],
    created: 0,
    writes: [],
    sessionPosts: [],
    presence: [],
    sessions: [sessions.s1, sessions.s2],
    pushDevices: 0,
    // /api/views answers 500 to reads and writes while set.
    failRead: false,
  };
  const answerWrite = (route, method, id, body) => {
    controls.writes.push({ method, id, body });
    const view = controls.views.find((item) => item.id === id);
    if (!view) return route.fulfill({ status: 404, json: { error: "Unknown view" } });
    if (method === "DELETE") {
      controls.views = controls.views.filter((item) => item !== view);
      return route.fulfill({ json: { version: ++controls.version } });
    }
    if (body.name !== undefined && !String(body.name).trim())
      return route.fulfill({
        status: 400,
        json: { error: "A view needs a name.", code: "VIEW_NAME_INVALID" },
      });
    const next = {
      ...view,
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.layout !== undefined ? { layout: body.layout } : {}),
      ...(body.used ? { usedAt: new Date().toISOString() } : {}),
      revision: view.revision + 1,
    };
    controls.views = controls.views.map((item) => (item === view ? next : item));
    return route.fulfill({ json: { version: ++controls.version, view: next } });
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/api/state")
      return route.fulfill({
        json: {
          home: "/fixture",
          tools: ["claude", "codex"].map((id) => ({ id, name: id, installed: true })),
          accounts: [],
          sessions: controls.sessions,
          providerConnections: [],
          pushDevices: controls.pushDevices,
        },
      });
    if (path === "/api/views" && method === "GET" && controls.failRead)
      return route.fulfill({ status: 500, json: { error: "Views unavailable" } });
    if (path === "/api/views" && method === "GET")
      return route.fulfill({
        json: { version: controls.version, views: controls.views },
      });
    if (path === "/api/views" && method === "POST") {
      const body = request.postDataJSON();
      controls.writes.push({ method, body });
      if (controls.views.length >= 30)
        return route.fulfill({
          status: 400,
          json: { error: "At most 30 views.", code: "VIEW_LIMIT" },
        });
      const now = new Date().toISOString();
      const view = {
        id: `v_new${String(++controls.created).padStart(13, "0")}`,
        name: body.name,
        layout: body.layout,
        revision: 1,
        createdAt: now,
        usedAt: now,
      };
      controls.views = [...controls.views, view];
      return route.fulfill({ status: 201, json: { version: ++controls.version, view } });
    }
    const write = /^\/api\/views\/([^/]+)$/.exec(path);
    if (write) {
      if (controls.failRead)
        return route.fulfill({ status: 500, json: { error: "Views unavailable" } });
      const body = method === "PATCH" ? request.postDataJSON() : null;
      return answerWrite(route, method, write[1], body);
    }
    if (path.startsWith("/api/notifications")) {
      if (path.endsWith("/presence"))
        controls.presence.push(request.postDataJSON().route);
      return route.fulfill({ status: method === "GET" ? 200 : 204, json: {} });
    }
    const session = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    if (session) {
      if (method === "POST") controls.sessionPosts.push(path);
      const rest = session[2] || "";
      if (rest === "/chat")
        return route.fulfill({
          json: { availability: "ready", tasks: [], messages: [] },
        });
      const owner = sessions[session[1]];
      if (owner && rest.startsWith("/files/explorer"))
        return route.fulfill({
          json: explorerAnswer(owner, rest.slice("/files/explorer".length), url),
        });
      return route.fulfill({ json: {} });
    }
    return route.fallback();
  });
  return controls;
}

/** The view writes that changed its layout, in order. */
export const layoutWrites = (controls) =>
  controls.writes.filter((write) => write.body?.layout !== undefined);

/** The pane of `key` ("session:s1", "chat:a1:c1"). */
export const paneOf = (page, key) => page.locator(`.split-pane[data-pane-key="${key}"]`);
