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
