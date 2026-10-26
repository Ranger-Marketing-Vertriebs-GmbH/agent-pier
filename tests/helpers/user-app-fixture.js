import { installUserFeedFake } from "./agent-feed-fake.js";
import { defaultPreferences } from "../../server/features/notifications/push-preferences.js";

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
    // The main chat's event area (routine and check-in results), by chat id.
    areaEvents: options.areaEvents || {},
    requests: options.requests || {},
    // Chats whose history says they are very long, by id.
    longChat: options.longChat || {},
    settings: Object.fromEntries(agents.map((a) => [a.id, settingsOf(a)])),
    memory: options.memory || {},
    reminders: options.reminders || {},
    routines: options.routines || {},
    approvals: options.approvals || [],
    notifications: options.notifications || {
      enabled: true,
      publicKey: "AQAB",
      subscriptions: [],
    },
    notificationCalls: [],
    browser: options.browser || {},
    telegramChannels: options.telegram || {},
    telegram: [],
    // Events her stream sends on its next reconnect (with `eventRetry` set).
    events: [],
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
      state.logoutBody = route.request().postDataJSON();
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
        body:
          [
            `retry: ${options.eventRetry ?? 600000}`,
            'data: {"type":"connected"}',
            ...state.events.splice(0).map((event) => `data: ${JSON.stringify(event)}`),
          ].join("\n\n") + "\n\n",
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
  if (rest === "/memory") {
    // Paged as the server pages them (native-memory.js), `pageSize` per page.
    const { files = [], pageSize } = state.memory[id] || {};
    if (!pageSize) return json(route, { files });
    const offset = Number(new URL(route.request().url()).searchParams.get("offset") || 0);
    state.memoryPages = [...(state.memoryPages || []), offset];
    const next = offset + pageSize;
    return json(route, {
      files: files.slice(offset, next),
      total: files.length,
      nextOffset: next < files.length ? next : null,
    });
  }
  let m;
  if ((m = /^\/memory\/(.+)$/.exec(rest)) && method === "GET") {
    const name = decodeURIComponent(m[1]);
    const content = state.memory[id]?.contents?.[name];
    if (content === undefined) return missing(route);
    // A diary past the read limit: its newest part and its whole size.
    const size = state.memory[id]?.truncated?.[name];
    return json(route, {
      name,
      content,
      readOnly: true,
      ...(size ? { truncated: true, size } : {}),
    });
  }
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
    if (method === "GET") return json(route, { [m[1]]: list });
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
  // Her own bot at Extended (me-telegram.js); `state.telegram` records the calls.
  if (rest === "/telegram" && method === "GET")
    return json(route, { channel: state.telegramChannels[id] ?? null });
  // The same bot connected again after Disconnect is paired with her chat again.
  if (rest === "/telegram" && method === "PUT") {
    state.telegram.push({ method, ...body() });
    const kept = Boolean(state.telegramChannels[id]?.keptChat);
    state.telegramChannels[id] = {
      id: `channel-${id}`,
      username: `${id}_bot`,
      enabled: true,
      connected: true,
      paired: kept,
      revision: 1,
    };
    return json(route, { channel: state.telegramChannels[id] });
  }
  if (rest === "/telegram/pair") {
    state.telegram.push({ method });
    return json(route, {
      code: "123456",
      url: `https://t.me/${id}_bot?start=123456`,
      expiresAt: "2026-10-21T10:00:00.000Z",
    });
  }
  if (rest === "/telegram" && method === "DELETE") {
    state.telegram.push({ method });
    const previous = state.telegramChannels[id];
    state.telegramChannels[id] = {
      ...previous,
      enabled: false,
      connected: false,
      paired: false,
      keptChat: Boolean(previous?.paired || previous?.keptChat),
    };
    return json(route, { channel: state.telegramChannels[id] });
  }
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
  // The long-chat hint's actions: the history is summarised, or the hint hidden.
  if (rest === "/compact" || rest === "/long-chat-dismissal") {
    state.longChatCalls = [...(state.longChatCalls || []), `${id}${rest}`];
    delete state.longChat?.[id];
    return json(route, rest === "/compact" ? { compacted: true } : { dismissed: true });
  }
  if (rest === "/attachment-policy") return json(route, { imageInput: true });
  if (rest === "/messages" && method === "POST") {
    const { text } = body();
    state.posted.push({ id, text });
    // `/new` starts a chat on the server (chat-commands.js) and names it.
    if (text.trim() === "/new") {
      const created = userChat({ id: `chat-${Date.now()}`, main: false });
      const agentId = Object.keys(state.chats).find((a) =>
        state.chats[a].some((c) => c.id === id),
      );
      state.chats[agentId].push(created);
      return json(route, { created: created.id }, 201);
    }
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
      ...(state.areaEvents[id] ? { events: state.areaEvents[id] } : {}),
      ...(state.compacting?.[id] ? { compacting: true } : {}),
      ...(state.longChat?.[id] ? { longChat: true } : {}),
    });
  if (rest === "/queued") return json(route, { text: "" });
  return missing(route);
}

function notifications(route, state, path) {
  const request = route.request();
  const method = request.method();
  if (path === "/api/me/notifications" && method === "GET")
    return json(route, state.notifications);
  if (path === "/api/me/notifications/presence")
    return route.fulfill({ status: 204, body: "" });
  const body = ["POST", "PUT"].includes(method) ? request.postDataJSON() : null;
  state.notificationCalls.push({ path, method, body });
  if (path === "/api/me/notifications/subscriptions" && method === "POST") {
    const subscription = {
      id: "device-1",
      deviceId: body.deviceId,
      label: body.label,
      createdAt: "2026-10-20T09:00:00Z",
      preferences: defaultPreferences(body.timeZone),
    };
    state.notifications.subscriptions = [subscription];
    return json(route, { subscription }, 201);
  }
  return json(route, { ok: true });
}

/** A browser push stack (permission, worker, push manager) that always subscribes. */
export const installPushStack = (page) =>
  page.addInitScript(() => {
    const subscription = {
      toJSON: () => ({
        endpoint: "https://push.example.invalid/device",
        keys: { p256dh: "fixture", auth: "fixture" },
      }),
      unsubscribe: async () => {
        current = null;
        window.pushUnsubscribed = true;
        return true;
      },
    };
    let current = null;
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: {
        permission: "default",
        requestPermission: async () => {
          window.Notification.permission = "granted";
          return "granted";
        },
      },
    });
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: function () {},
    });
    const registration = {
      pushManager: {
        getSubscription: async () => current,
        subscribe: async () => (current = subscription),
      },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: Object.assign(new EventTarget(), {
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
        register: async () => registration,
      }),
    });
  });
