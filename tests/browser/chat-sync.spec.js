import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

const message = (id, text) => ({ id, role: "assistant", text });
const full = (cursor, messages, providerSessionId = "native-one") => ({
  availability: "ready",
  providerSessionId,
  messages,
  tasks: [],
  sync: { mode: "full", cursor },
});
async function fixture(page, chat) {
  const session = {
    id: "sync",
    name: "Sync",
    accountId: "local-claude",
    tool: "claude",
    status: "running",
    cwd: "/fixture",
  };
  const calls = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let result = {};
    if (url.pathname === "/api/state")
      result = {
        tools: [{ id: "claude", name: "Claude", installed: true }],
        accounts: [{ id: "local-claude", name: "Claude", tool: "claude", kind: "local" }],
        sessions: [session],
        home: "/fixture",
      };
    else if (url.pathname.endsWith("/chat")) {
      calls.push(url.searchParams.get("cursor"));
      return chat(route, url.searchParams.get("cursor"));
    } else if (url.pathname.endsWith("/choices"))
      result = { choices: [{ id: "native-two", title: "Zweiter Verlauf" }] };
    else if (url.pathname.endsWith("/bind"))
      result = full("bound", [message("new", "Neuer Verlauf")], "native-two");
    await route.fulfill({ json: result });
  });
  await page.goto(baseURL + "/sessions/sync/chat");
  return calls;
}

test("chat polls with its cursor, applies changes and recovers from an unusable delta", async ({
  page,
}) => {
  let stage = 0;
  const original = full("first", [
    message("a", "Erster Text"),
    message("b", "Bleibt erhalten"),
  ]);
  const calls = await fixture(page, (route, cursor) => {
    if (!cursor)
      return route.fulfill({
        json:
          stage < 2
            ? original
            : full("recovered", [message("r", "Vollständig wiederhergestellt")]),
      });
    if (stage === 1)
      return route.fulfill({
        json: {
          sync: { mode: "delta", base: "first", cursor: "second" },
          metadata: { availability: "ready", providerSessionId: "native-one", tasks: [] },
          upserts: [message("c", "Nachgeladener Text")],
          removed: ["a"],
          order: ["b", "c"],
        },
      });
    if (stage === 2)
      return route.fulfill({
        json: {
          sync: { mode: "delta", base: "wrong-base", cursor: "third" },
          metadata: {},
          upserts: [],
          removed: [],
        },
      });
    return route.fulfill({ json: original });
  });
  const history = page.getByLabel("Chatverlauf");
  await expect(history).toContainText("Erster Text");
  await page
    .getByRole("textbox", { name: "Nachricht", exact: true })
    .fill("Bleibender Entwurf");
  stage = 1;
  await expect(history).toContainText("Nachgeladener Text");
  await expect(history).not.toContainText("Erster Text");
  await expect(history).toContainText("Bleibt erhalten");
  expect(calls).toContain("first");
  stage = 2;
  await expect(history).toContainText("Vollständig wiederhergestellt");
  expect(calls.slice(-2)).toEqual(["second", null]);
  await expect(page.getByRole("textbox", { name: "Nachricht", exact: true })).toHaveValue(
    "Bleibender Entwurf",
  );
});

test("an old failed poll cannot mark a newly selected conversation disconnected", async ({
  page,
}) => {
  let release;
  let started = false;
  let bound = false;
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  await fixture(page, async (route, cursor) => {
    if (!cursor)
      return route.fulfill({
        json: bound
          ? full("bound", [message("new", "Neuer Verlauf")], "native-two")
          : full("first", [message("old", "Alter Verlauf")]),
      });
    started = true;
    await delayed;
    await route.fulfill({ status: 500, json: { error: "Veralteter Lesefehler" } });
  });
  await expect(page.getByLabel("Chatverlauf")).toContainText("Alter Verlauf");
  await expect.poll(() => started).toBe(true);
  await page.getByRole("button", { name: "Verlauf wechseln", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Unterhaltung", exact: true })
    .selectOption("native-two");
  bound = true;
  await page.getByRole("button", { name: "Verknüpfen", exact: true }).click();
  await expect(page.getByLabel("Chatverlauf")).toContainText("Neuer Verlauf");
  release();
  // Let the rejected old read settle before asserting that its error was ignored.
  await page.waitForTimeout(150);
  await expect(page.getByText("Veralteter Lesefehler", { exact: true })).toHaveCount(0);
  await expect(page.locator(".connection")).toHaveText("Verbunden");
});
