import { installUserFeedFake } from "./agent-feed-fake.js";

// A routed stand-in for a restricted user's server: /auth/status says she is signed in
// and every /api/me route answers from `state`. Requests outside /auth and /api/me are
// recorded in `state.foreign`, so a spec can prove her app never calls the owner's API.

export const anna = { id: "u-anna", username: "anna", displayName: "Anna" };

/** One of her agents as GET /api/me/agents lists it. */
export const userAgent = (overrides = {}) => ({
  id: "lotta",
  name: "Lotta",
  avatar: null,
  shared: false,
  level: "chat",
  conversationId: "main",
  activity: { state: "idle", reason: null, label: null },
  ...overrides,
});

/** A chat summary as her chat list shows it. */
export const userChat = (overrides = {}) => ({
  id: "main",
  title: null,
  main: true,
  archivedAt: null,
  lastActivityAt: "2026-10-20T09:00:00.000Z",
  busy: false,
  ...overrides,
});

const settingsOf = (agent) => ({
  revision: 1,
  fields: agent.shared
    ? []
    : agent.level === "extended"
      ? ["name", "avatar", "instructions", "capabilities"]
      : agent.level === "personalize"
        ? ["name", "avatar", "instructions"]
        : [],
  values: {
    name: agent.name,
    avatar: agent.avatar,
    instructions: "Be brief.",
    ...(agent.released?.length && {
      capabilities: Object.fromEntries(agent.released.map((key) => [key, false])),
    }),
  },
  level: agent.level,
  shared: agent.shared,
  released: agent.released || [],
});

const json = (route, body, status = 200) => route.fulfill({ status, json: body });
const missing = (route) =>
  route.fulfill({
    status: 404,
    json: { error: "Not found", messageKey: "http.notFound" },
  });

export async function userAppFixture(page, options = {}) {
  const {
    language = "en",
    user = anna,
    agents = [userAgent()],
    ownerMayRead = { enabled: false, since: null },
  } = options;
  const state = {
    user,
    ownerMayRead,
    agents: agents.map((a) => ({ ...a })),
    chats:
      options.chats ||
      Object.fromEntries(agents.map((a) => [a.id, [userChat({ id: a.conversationId })]])),
    messages: options.messages || {},
    requests: options.requests || {},
    settings: Object.fromEntries(agents.map((a) => [a.id, settingsOf(a)])),
    memory: options.memory || {},
    reminders: options.reminders || {},
    routines: options.routines || {},
    approvals: options.approvals || [],
    notifications: options.notifications || { configured: true, subscriptions: [] },
    browser: options.browser || {},
    password: options.password || "current-password-1",
    posted: [],
    saved: [],
    decided: [],
    foreign: [],
    signedOut: false,
  };
  const chatOf = (id) =>
    Object.entries(state.chats)
      .map(([agentId, list]) => [agentId, list.find((c) => c.id === id)])
      .find(([, c]) => c);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(page.url() || request.url()).origin) return;
    if (
      /^\/(?:api|auth)\//.test(url.pathname) &&
      !/^\/(?:auth|api\/me)(?:\/|$)/.test(url.pathname)
    )
      state.foreign.push(`${request.method()} ${url.pathname}`);
  });
  await installUserFeedFake(page);
  await page.addInitScript((value) => {
    localStorage.setItem("agentpier-language", value);
  }, language);
  await page.route(/\/auth\/(?:status|logout)$/, (route) => {
    if (route.request().url().endsWith("/logout")) {
      state.signedOut = true;
      return json(route, {});
    }
    return json(
      route,
      state.signedOut
        ? { configured: true, authenticated: false, role: null, user: null }
        : { configured: true, authenticated: true, role: "user", user: state.user },
    );
  });
  await page.route(/\/api\//, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const body = () => request.postDataJSON() || {};
    let m;
    if (!path.startsWith("/api/me")) return missing(route);
    if (path === "/api/me")
      return json(route, { user: state.user, ownerMayRead: state.ownerMayRead });
    if (path === "/api/me/password") {
      const { current, next } = body();
      if (current !== state.password)
        return json(route, { error: "Wrong password", code: "USER_PASSWORD_WRONG" }, 400);
      state.password = next;
      return route.fulfill({ status: 204, body: "" });
    }
    if (path === "/api/me/dictation") return json(route, { available: false });
    if (path === "/api/me/events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'retry: 600000\ndata: {"type":"connected"}\n\n',
      });
    if (path === "/api/me/agents") return json(route, state.agents);
    if (path === "/api/me/approvals") return json(route, { actions: state.approvals });
    if ((m = /^\/api\/me\/approvals\/([^/]+)\/decision$/.exec(path))) {
      state.decided.push({ id: m[1], ...body() });
      state.approvals = state.approvals.filter((a) => a.id !== m[1]);
      return json(route, { ok: true });
    }
    if (path.startsWith("/api/me/notifications"))
      return notifications(route, state, path);
    if ((m = /^\/api\/me\/agents\/([^/]+)(\/.*)?$/.exec(path))) {
      const agent = state.agents.find((a) => a.id === m[1]);
      if (!agent) return missing(route);
      return agentRoute(route, state, agent, m[2] || "", method, body);
    }
    if ((m = /^\/api\/me\/conversations\/([^/]+)(\/.*)?$/.exec(path))) {
      const found = chatOf(m[1]);
      if (!found) return missing(route);
      return chatRoute(route, state, found[1], m[2] || "", method, body);
    }
    if ((m = /^\/api\/me\/attempts\/([^/]+)\/(cancel|recover)$/.exec(path)))
      return json(route, { ok: true });
    return missing(route);
  });
  return state;
}

function agentRoute(route, state, agent, rest, method, body) {
  const id = agent.id;
  if (rest === "/conversation") {
    const main = state.chats[id]?.find((c) => c.main);
    return json(route, { id: main?.id || agent.conversationId });
  }
  if (rest === "/chats" && method === "GET") {
    const archived = new URL(route.request().url()).searchParams.get("archived") === "1";
    return json(
      route,
      (state.chats[id] || []).filter((c) => !!c.archivedAt === archived),
    );
  }
  if (rest === "/chats" && method === "POST") {
    const chat = userChat({
      id: `chat-${Date.now()}`,
      main: false,
      lastActivityAt: new Date().toISOString(),
    });
    state.chats[id] = [...(state.chats[id] || []), chat];
    return json(route, chat, 201);
  }
  if (rest === "/settings" && method === "GET") return json(route, state.settings[id]);
  if (rest === "/settings" && method === "PATCH") {
    const { values, revision } = body();
    const current = state.settings[id];
    if (revision !== current.revision)
      return json(route, { error: "Changed", messageKey: "assistants.conflict" }, 409);
    state.saved.push({ id, values });
    state.settings[id] = {
      ...current,
      revision: current.revision + 1,
      values: { ...current.values, ...values },
    };
    if (values.name) agent.name = values.name;
    return json(route, state.settings[id]);
  }
  if (rest === "/memory") return json(route, state.memory[id] || { files: [] });
  let m;
  if ((m = /^\/memory\/(.+)$/.exec(rest)) && method === "DELETE") {
    const name = decodeURIComponent(m[1]);
    const files = state.memory[id]?.files || [];
    state.memory[id] = {
      ...state.memory[id],
      files: files.filter((f) => f.name !== name),
    };
    return route.fulfill({ status: 204, body: "" });
  }
  if ((m = /^\/(reminders|routines)(?:\/([^/]+))?$/.exec(rest))) {
    const store = state[m[1]];
    const list = (store[id] ||= []);
    if (method === "GET") return json(route, list);
    if (method === "POST") {
      const item = { id: `b-${list.length + 1}`, state: "bound", ...body() };
      list.push(item);
      return json(route, item, 201);
    }
    const index = list.findIndex((b) => b.id === m[2]);
    if (method === "DELETE") {
      list.splice(index, 1);
      return json(route, { removed: true });
    }
    list[index] = { ...list[index], ...body() };
    return json(route, list[index]);
  }
  if (rest === "/telegram") return json(route, { channel: null });
  if (rest === "/browser")
    return json(route, {
      running: false,
      watchable: false,
      ...state.browser[id],
    });
  return missing(route);
}

function chatRoute(route, state, chat, rest, method, body) {
  const id = chat.id;
  if (rest === "" && method === "PATCH") {
    chat.title = body().title;
    return json(route, chat);
  }
  if (rest === "" && method === "DELETE") {
    for (const [agentId, list] of Object.entries(state.chats))
      state.chats[agentId] = list.filter((c) => c.id !== id);
    return route.fulfill({ status: 204, body: "" });
  }
  if (rest === "/archive") {
    chat.archivedAt = new Date().toISOString();
    return json(route, chat);
  }
  if (rest === "/restore") {
    chat.archivedAt = null;
    return json(route, chat);
  }
  if (rest === "/attachment-policy") return json(route, { imageInput: true });
  if (rest === "/messages" && method === "POST") {
    const { text } = body();
    state.posted.push({ id, text });
    const messages = (state.messages[id] ||= []);
    messages.push(
      { id: `u-${messages.length}`, role: "user", text },
      { id: `a-${messages.length}`, role: "assistant", text: `Reply to: ${text}` },
    );
    chat.lastActivityAt = new Date().toISOString();
    return json(route, { accepted: true }, 202);
  }
  if (rest === "/messages")
    return json(route, {
      messages: state.messages[id] || [],
      requests: state.requests[id] || [],
      stale: false,
    });
  if (rest === "/queued") return json(route, { text: "" });
  return missing(route);
}

function notifications(route, state, path) {
  const method = route.request().method();
  if (path === "/api/me/notifications" && method === "GET")
    return json(route, state.notifications);
  if (path === "/api/me/notifications/presence")
    return route.fulfill({ status: 204, body: "" });
  if (path === "/api/me/notifications/subscriptions" && method === "POST") {
    const subscription = {
      id: `device-${state.notifications.subscriptions.length + 1}`,
      label: "This browser",
      current: true,
      preferences: {},
    };
    state.notifications.subscriptions.push(subscription);
    return json(route, { subscription }, 201);
  }
  return json(route, { ok: true });
}
