import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

const DATABASE = "agentpier.chat.cache.v1";
const session = (id) => ({
  id,
  name: `Session ${id}`,
  accountId: "local-claude",
  tool: "claude",
  status: "stopped",
  cwd: "/fixture",
  createdAt: "2026-09-06T10:00:00Z",
});
const keyOf = (item) =>
  JSON.stringify([item.id, item.accountId, item.tool, item.createdAt]);
const snapshot = () => ({
  availability: "ready",
  providerSessionId: "native",
  messages: [{ id: "m1", role: "assistant", text: "Cached text" }],
  tasks: [],
  sync: { mode: "full", cursor: "c1" },
  history: { cursor: null, generation: "native" },
});
const entry = (item) => ({
  version: 1,
  key: keyOf(item),
  sessionId: item.id,
  savedAt: Date.now(),
  accessedAt: Date.now(),
  size: 1,
  live: snapshot(),
  older: [],
  cursor: "c1",
  paged: false,
});

async function fixture(page) {
  const state = {
    sessions: [session("one"), session("two")],
    authenticated: true,
    deletes: [],
  };
  await page.routeWebSocket(/\/chat-stream(\?.*)?$/, (socket) => {
    socket.send(JSON.stringify({ type: "sync", sequence: 1, data: snapshot() }));
  });
  await page.route("**/auth/status", (route) =>
    route.fulfill({
      json: { configured: true, authenticated: state.authenticated, canSetup: false },
    }),
  );
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "claude", name: "claude", installed: true }],
          accounts: [],
          sessions: state.sessions,
          home: "/fixture",
        },
      });
    if (
      route.request().method() === "DELETE" &&
      url.pathname.startsWith("/api/sessions/")
    ) {
      const id = url.pathname.split("/").pop();
      state.deletes.push(id);
      state.sessions = state.sessions.filter((item) => item.id !== id);
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ json: url.pathname.endsWith("/chat") ? snapshot() : {} });
  });
  await page.goto(baseURL + "/sessions/one/chat");
  await expect(page.locator(".chat-messages")).toContainText("Cached text");
  return state;
}

const seed = (page, entries) =>
  page.evaluate(
    async ({ database, entries: rows }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(database, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("sessions", { keyPath: "key" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("sessions", "readwrite");
        for (const row of rows) transaction.objectStore("sessions").put(row);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    },
    { database: DATABASE, entries },
  );
const storedKeys = (page) =>
  page.evaluate(async (database) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(database, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("sessions", { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise((resolve) => {
      const request = db.transaction("sessions").objectStore("sessions").getAllKeys();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return keys.sort();
  }, DATABASE);
const loginHeading = (page) =>
  page.getByRole("heading", { name: "Anmelden", exact: true });

test("logout empties the chat cache", async ({ page }) => {
  const state = await fixture(page);
  await seed(page, state.sessions.map(entry));
  expect(await storedKeys(page)).toHaveLength(2);
  await page.getByRole("button", { name: "Abmelden", exact: true }).click();
  await expect(loginHeading(page)).toBeVisible();
  await expect.poll(() => storedKeys(page)).toEqual([]);
});

test("a detected login loss on refresh empties the chat cache", async ({ page }) => {
  const state = await fixture(page);
  await seed(page, state.sessions.map(entry));
  state.authenticated = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(loginHeading(page)).toBeVisible();
  await expect.poll(() => storedKeys(page)).toEqual([]);
});

test("the login-required event empties the chat cache", async ({ page }) => {
  const state = await fixture(page);
  await seed(page, state.sessions.map(entry));
  await page.evaluate(() => window.dispatchEvent(new Event("agentpier-login-required")));
  await expect.poll(() => storedKeys(page)).toEqual([]);
});

test("another tab's auth change empties the chat cache", async ({ page }) => {
  const state = await fixture(page);
  await seed(page, state.sessions.map(entry));
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", { key: "agentpier-auth-change", newValue: "1" }),
    ),
  );
  await expect.poll(() => storedKeys(page)).toEqual([]);
});

test("deleting a session removes its cache entry", async ({ page }) => {
  const state = await fixture(page);
  await seed(page, state.sessions.map(entry));
  await page.getByRole("button", { name: "Sitzung entfernen" }).click();
  await page.getByRole("button", { name: "Jetzt entfernen" }).click();
  await expect.poll(() => state.deletes).toEqual(["one"]);
  await expect.poll(() => storedKeys(page)).toEqual([keyOf(session("two"))]);
});

test("a workspace state without a session prunes its cache entry", async ({ page }) => {
  const state = await fixture(page);
  const ghost = session("ghost");
  await seed(page, [...state.sessions.map(entry), entry(ghost)]);
  expect(await storedKeys(page)).toContain(keyOf(ghost));
  await page.reload();
  await expect(page.locator(".chat-messages")).toContainText("Cached text");
  await expect.poll(() => storedKeys(page)).toEqual(state.sessions.map(keyOf).sort());
});

// Restoring a cached chat: a scripted chat server whose first frame can be held back.
const running = (id) => ({ ...session(id), status: "running" });
const rows = (prefix, count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    role: "assistant",
    text: `Nachricht ${prefix} ${i}: ${"Inhalt der Unterhaltung ".repeat(6)}`,
  }));
const liveSnapshot = (id, cursor, extra = {}) => ({
  availability: "ready",
  providerSessionId: `native-${id}`,
  messages: rows(id, 40),
  tasks: [],
  observability: { context: {} },
  sync: { mode: "full", cursor },
  history: { cursor: null, generation: `native-${id}` },
  ...extra,
});
const warning = (id) => ({
  providerSessionId: `native-${id}`,
  warnings: ["Fixture-Limit fast erreicht"],
});

async function restoreFixture(page, { delayState = 0 } = {}) {
  const server = {
    sessions: [running("a"), running("b")],
    snapshots: { a: liveSnapshot("a", "a1"), b: liveSnapshot("b", "b1") },
    hold: false,
    queue: [],
    frames: [],
    historyReads: 0,
  };
  await page.routeWebSocket(/\/api\/sessions\/[^/]+\/chat-stream(\?.*)?$/, (socket) => {
    const url = new URL(socket.url());
    const id = url.pathname.split("/").at(-2);
    const cursor = url.searchParams.get("cursor");
    const current = server.snapshots[id];
    let data = current;
    if (cursor && cursor === current.sync.cursor) {
      const next = `${cursor}+`;
      const { messages, sync: _sync, ...metadata } = current;
      data = {
        sync: { mode: "delta", base: cursor, cursor: next },
        metadata,
        upserts: [],
        removed: [],
        order: messages.map((row) => row.id),
      };
      server.snapshots[id] = { ...current, sync: { mode: "full", cursor: next } };
    }
    const deliver = () => {
      server.frames.push({ id, cursor, mode: data.sync.mode });
      socket.send(JSON.stringify({ type: "sync", sequence: 1, data }));
    };
    if (server.hold) server.queue.push(deliver);
    else deliver();
  });
  server.release = () => {
    server.hold = false;
    for (const deliver of server.queue.splice(0)) deliver();
  };
  await page.route("**/auth/status", (route) =>
    route.fulfill({ json: { configured: true, authenticated: true, canSetup: false } }),
  );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/state") {
      if (delayState) await new Promise((resolve) => setTimeout(resolve, delayState));
      return route.fulfill({
        json: {
          tools: [{ id: "claude", name: "claude", installed: true }],
          accounts: [],
          sessions: server.sessions,
          home: "/fixture",
        },
      });
    }
    if (url.pathname.endsWith("/chat/history")) {
      server.historyReads++;
      return route.fulfill({
        json: { providerSessionId: "native-a", messages: [], history: { cursor: null } },
      });
    }
    return route.fulfill({ json: {} });
  });
  return server;
}

const chatOf = (page) => page.getByLabel("Chatverlauf");
const sessionRow = (page, name) =>
  page.locator(".session-item").filter({ has: page.getByText(name, { exact: true }) });
// The first fully visible message row and its distance from the viewport top.
const firstVisibleRow = (page) =>
  chatOf(page).evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    for (const row of element.querySelectorAll("[data-message-id]")) {
      const box = row.getBoundingClientRect();
      if (box.height > 0 && box.top >= top)
        return { id: row.dataset.messageId, offset: box.top - top };
    }
    return null;
  });
const rowOffset = (page, id) =>
  chatOf(page).evaluate(
    (element, messageId) =>
      element.querySelector(`[data-message-id="${messageId}"]`).getBoundingClientRect()
        .top - element.getBoundingClientRect().top,
    id,
  );
const atBottom = (page) =>
  chatOf(page).evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 80,
  );
const limitWarning = (page) => page.getByRole("status", { name: "Limit-Warnung" });

async function visitAndScroll(page, server, beforeReturn = () => {}) {
  await page.goto(baseURL + "/sessions/a/chat");
  await expect(chatOf(page)).toContainText("Nachricht a 39");
  await chatOf(page).evaluate((element) => {
    element.scrollTop = 900;
  });
  await page.waitForTimeout(200);
  const anchor = await firstVisibleRow(page);
  expect(anchor?.id).toMatch(/^a-/);
  await sessionRow(page, "Session b").click();
  await expect(chatOf(page)).toContainText("Nachricht b 39");
  server.hold = true;
  beforeReturn();
  await sessionRow(page, "Session a").click();
  return anchor;
}

test("switching back restores a cached chat that is not shown as live", async ({
  page,
}) => {
  const server = await restoreFixture(page);
  server.snapshots.a = liveSnapshot("a", "a1", { nativeInput: warning("a") });
  await page.goto(baseURL + "/sessions/a/chat");
  await expect(limitWarning(page)).toBeVisible();
  const anchor = await visitAndScroll(page, server);
  await expect(chatOf(page)).toContainText("Nachricht a 0");
  await expect(page.locator(".connection")).not.toHaveText(/^Verbunden$/);
  await expect(page.locator(".chat-context-budget")).toContainText("Gespeicherter Stand");
  await expect(limitWarning(page)).toHaveCount(0);
  expect(Math.abs((await rowOffset(page, anchor.id)) - anchor.offset)).toBeLessThan(4);
  await expect.poll(() => server.queue.length).toBe(1);
  server.release();
  await expect(page.locator(".connection")).toHaveText("Verbunden");
  expect(server.frames.at(-1)).toEqual({ id: "a", cursor: "a1", mode: "delta" });
  await expect(page.locator(".chat-context-budget")).not.toContainText(
    "Gespeicherter Stand",
  );
  await expect(limitWarning(page)).toBeVisible();
  expect(Math.abs((await rowOffset(page, anchor.id)) - anchor.offset)).toBeLessThan(4);
});

test("a first frame that resets the window sticks to the bottom", async ({ page }) => {
  const server = await restoreFixture(page);
  const anchor = await visitAndScroll(page, server, () => {
    server.snapshots.a = liveSnapshot("a", "other", { providerSessionId: "native-x" });
  });
  await expect.poll(() => server.queue.length).toBe(1);
  expect(Math.abs((await rowOffset(page, anchor.id)) - anchor.offset)).toBeLessThan(4);
  expect(await atBottom(page)).toBe(false);
  server.release();
  await expect(page.locator(".connection")).toHaveText("Verbunden");
  expect(server.frames.at(-1).mode).toBe("full");
  await expect.poll(() => atBottom(page)).toBe(true);
});

test("a reload restores the device cache before the first frame", async ({ page }) => {
  // The cache preload races /api/state; the delay makes the restored path certain.
  const server = await restoreFixture(page, { delayState: 300 });
  await page.goto(baseURL + "/sessions/b/chat");
  await expect(chatOf(page)).toContainText("Nachricht b 39");
  const cached = {
    ...entry(running("a")),
    live: liveSnapshot("a", "a1", {
      nativeInput: warning("a"),
      history: { cursor: "older", generation: "native-a" },
    }),
    cursor: "older",
    scroll: { anchorId: "a-0", offset: 0, stick: false },
  };
  await seed(page, [cached]);
  server.hold = true;
  await page.goto(baseURL + "/sessions/a/chat");
  await expect(chatOf(page)).toContainText("Nachricht a 0");
  await expect.poll(() => server.queue.length).toBe(1);
  expect(await chatOf(page).evaluate((element) => element.scrollTop)).toBeLessThan(100);
  await expect(page.locator(".connection")).not.toHaveText(/^Verbunden$/);
  await expect(page.locator(".chat-context-budget")).toContainText("Gespeicherter Stand");
  await expect(limitWarning(page)).toHaveCount(0);
  await chatOf(page).evaluate((element) => {
    element.scrollTop = 10;
  });
  await page.waitForTimeout(500);
  expect(server.historyReads).toBe(0);
  server.release();
  await expect(page.locator(".connection")).toHaveText("Verbunden");
  expect(server.frames.at(-1)).toEqual({ id: "a", cursor: "a1", mode: "delta" });
});
