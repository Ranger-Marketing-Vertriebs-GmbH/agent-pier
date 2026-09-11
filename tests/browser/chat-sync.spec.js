import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

const message = (id, text) => ({ id, role: "assistant", text });
const full = (
  cursor,
  messages,
  providerSessionId = "native-one",
  historyCursor = null,
) => ({
  availability: "ready",
  providerSessionId,
  messages,
  tasks: [],
  sync: { mode: "full", cursor },
  history: { cursor: historyCursor, generation: providerSessionId },
});
async function fixture(
  page,
  initial,
  history = async (route) => route.fulfill({ json: {} }),
) {
  const state = {
    current: initial,
    sockets: [],
    reads: 0,
    historyReads: 0,
    sequence: 0,
    session: {
      id: "sync",
      name: "Sync",
      accountId: "local-claude",
      tool: "claude",
      status: "running",
      cwd: "/fixture",
    },
  };
  await page.routeWebSocket("**/api/sessions/sync/chat-stream", (socket) => {
    state.sockets.push(socket);
    state.sequence = 1;
    socket.send(JSON.stringify({ type: "sync", sequence: 1, data: state.current }));
  });
  state.send = (data) => {
    state.current = data;
    state.sockets
      .at(-1)
      .send(JSON.stringify({ type: "sync", sequence: ++state.sequence, data }));
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let result = {};
    if (url.pathname === "/api/state")
      result = {
        tools: [{ id: "claude", name: "Claude", installed: true }],
        accounts: [],
        sessions: [state.session],
        home: "/fixture",
      };
    else if (url.pathname.endsWith("/chat/history")) {
      state.historyReads++;
      return history(route, url, state);
    } else if (url.pathname.endsWith("/chat")) {
      state.reads++;
      result = state.current;
    }
    await route.fulfill({ json: result });
  });
  await page.goto(baseURL + "/sessions/sync/chat");
  await expect(page.getByLabel("Chatverlauf")).toContainText(initial.messages[0].text);
  return state;
}

test("chat receives live deltas without HTTP polling and reconnects from a full snapshot", async ({
  page,
}) => {
  const state = await fixture(
    page,
    full("first", [message("a", "Erster Text"), message("b", "Bleibt erhalten")]),
  );
  await page
    .getByRole("textbox", { name: "Nachricht", exact: true })
    .fill("Bleibender Entwurf");
  state.send({
    sync: { mode: "delta", base: "first", cursor: "second" },
    metadata: {
      availability: "ready",
      providerSessionId: "native-one",
      tasks: [],
      history: { cursor: null, generation: "native-one" },
    },
    upserts: [message("c", "Live-Antwort")],
    removed: ["a"],
    order: ["b", "c"],
  });
  const chat = page.getByLabel("Chatverlauf");
  await expect(chat).toContainText("Live-Antwort");
  await expect(chat).not.toContainText("Erster Text");
  await page.waitForTimeout(1800);
  expect(state.reads).toBe(0);
  state.current = full("reconnected", [message("r", "Nach Wiederverbindung")]);
  state.sockets.at(-1).close({ code: 1011, reason: "fixture reconnect" });
  await expect.poll(() => state.sockets.length).toBe(2);
  await expect(chat).toContainText("Nach Wiederverbindung");
  await expect(page.getByRole("textbox", { name: "Nachricht", exact: true })).toHaveValue(
    "Bleibender Entwurf",
  );
  expect(state.reads).toBeLessThanOrEqual(1);
});

test("older pages prepend once, preserve viewport, and clear removes all history", async ({
  page,
}) => {
  const latest = Array.from({ length: 30 }, (_, i) =>
    message(`new-${i}`, `Aktuelle Nachricht ${i}`),
  );
  const state = await fixture(
    page,
    full("first", latest, "native-one", "older"),
    async (route, url) => {
      expect(url.searchParams.get("cursor")).toBe("older");
      await route.fulfill({
        json: {
          providerSessionId: "native-one",
          messages: Array.from({ length: 20 }, (_, i) =>
            message(`old-${i}`, `Frühere Nachricht ${i}`),
          ),
          history: { cursor: null },
        },
      });
    },
  );
  const chat = page.getByLabel("Chatverlauf");
  await chat.evaluate((element) => {
    element.scrollTop = 50;
  });
  await expect(chat).toContainText("Frühere Nachricht 0");
  expect(state.historyReads).toBe(1);
  await page.screenshot({ path: "test-results/chat-stream-history.png" });
  await expect
    .poll(() => chat.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(500);
  const ids = await chat.locator(".chat-message").count();
  expect(ids).toBeGreaterThan(0);
  state.send(
    full(
      "updated",
      [...latest.slice(0, -1), message("new-29", "Aktualisierte Antwort")],
      "native-one",
      "older",
    ),
  );
  await expect(chat).toContainText("Frühere Nachricht 0");
  await expect(chat).toContainText("Aktualisierte Antwort");
  state.send(
    full(
      "rollover",
      [...latest.slice(1), message("new-30", "Neue Nachricht nach Fensterwechsel")],
      "native-one",
      "new-older",
    ),
  );
  await expect(chat).toContainText("Neue Nachricht nach Fensterwechsel");
  await expect(chat).toContainText("Aktuelle Nachricht 0");
  await expect(chat.locator(".chat-message")).toHaveCount(51);
  state.send(full("clear", [], "native-two"));
  await expect(chat).not.toContainText("Frühere Nachricht");
  await expect(chat).not.toContainText("Aktuelle Nachricht");
  expect(state.reads).toBe(0);
});

test("history loading can retry and a delayed old page cannot resurrect cleared messages", async ({
  page,
}) => {
  let release;
  const state = await fixture(
    page,
    full("first", [message("a", "Aktuelle Antwort")], "native-one", "older"),
    async (route, url, current) => {
      if (current.historyReads === 1)
        return route.fulfill({ status: 500, json: { error: "fixture failure" } });
      await new Promise((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        json: {
          providerSessionId: "native-one",
          messages: [message("old", "Veralteter Verlauf")],
          history: { cursor: null },
        },
      });
    },
  );
  await page
    .getByRole("button", { name: "Ältere Nachrichten laden", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Ältere Nachrichten konnten nicht geladen werden",
  );
  await page
    .getByRole("button", { name: "Ältere Nachrichten erneut laden", exact: true })
    .click();
  await expect.poll(() => Boolean(release)).toBe(true);
  state.send(full("clear", [], "native-two"));
  await expect(page.getByLabel("Chatverlauf")).not.toContainText("Aktuelle Antwort");
  release();
  await page.waitForTimeout(150);
  await expect(page.getByLabel("Chatverlauf")).not.toContainText("Veralteter Verlauf");
});

test("same-ID stopped and restarted sessions establish a fresh chat stream", async ({
  page,
}) => {
  const state = await fixture(page, full("first", [message("a", "Vor dem Neustart")]));
  const input = page.getByRole("textbox", { name: "Nachricht", exact: true });
  await input.fill("Entwurf bleibt erhalten");
  for (const [index, change] of [
    { status: "stopped" },
    { status: "running" },
    { restartGeneration: 1 },
  ].entries()) {
    state.sockets.at(-1).send(JSON.stringify({ type: "ended" }));
    await expect(page.locator(".connection")).not.toHaveText("Verbunden");
    Object.assign(state.session, change);
    state.current = full(`resumed-${index}`, [
      message(`reply-${index}`, `Nach Neustart ${index}`),
    ]);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await expect.poll(() => state.sockets.length).toBe(index + 2);
    await expect(page.getByLabel("Chatverlauf")).toContainText(`Nach Neustart ${index}`);
  }
  await expect(input).toHaveValue("Entwurf bleibt erhalten");
  expect(state.reads).toBe(0);
});

test("a disjoint live window resets older pagination to the newest cursor", async ({
  page,
}) => {
  const cursors = [];
  const state = await fixture(
    page,
    full(
      "initial",
      [message("a", "Ursprüngliches Fenster")],
      "native-one",
      "initial-older",
    ),
    async (route, url) => {
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      await route.fulfill({
        json: {
          providerSessionId: "native-one",
          messages: [
            cursor === "initial-older"
              ? message("old", "Vorher geladene Historie")
              : message("bridge", "Neu nachgeladene Historie"),
          ],
          history: { cursor: null },
        },
      });
    },
  );
  const chat = page.getByLabel("Chatverlauf");
  await page
    .getByRole("button", { name: "Ältere Nachrichten laden", exact: true })
    .click();
  await expect(chat).toContainText("Vorher geladene Historie");
  state.send(
    full(
      "burst",
      [message("z", "Neuestes Fenster nach großer Ausgabe")],
      "native-one",
      "newest-older",
    ),
  );
  await expect(chat).toContainText("Neuestes Fenster nach großer Ausgabe");
  await expect(chat).not.toContainText("Vorher geladene Historie");
  await expect(chat).not.toContainText("Ursprüngliches Fenster");
  await page
    .getByRole("button", { name: "Ältere Nachrichten laden", exact: true })
    .click();
  await expect(chat).toContainText("Neu nachgeladene Historie");
  expect(cursors).toEqual(["initial-older", "newest-older"]);
  expect(state.reads).toBe(0);
});

test("chat submits /clear and resets history only after the native conversation changes", async ({
  page,
}) => {
  const state = await fixture(
    page,
    full("before-clear", [message("old", "Old conversation")]),
  );
  const submissions = [];
  await page.route("**/api/sessions/sync/input", async (route) => {
    const body = route.request().postDataJSON();
    submissions.push(body);
    await route.fulfill({ json: { deliveryId: body.deliveryId, status: "handed-off" } });
  });
  await page.getByLabel("Nachricht", { exact: true }).fill("/clear");
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ text: "/clear", submit: true });
  await expect(page.getByLabel("Nachricht", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Chatverlauf")).toContainText("Old conversation");
  state.send(full("after-clear", [], "native-two"));
  await expect(page.getByLabel("Chatverlauf")).not.toContainText("Old conversation");
  state.send(full("new-answer", [message("new", "Fresh conversation")], "native-two"));
  await expect(page.getByLabel("Chatverlauf")).toContainText("Fresh conversation");
  await expect(page.getByLabel("Chatverlauf")).not.toContainText("Old conversation");
  expect(submissions).toHaveLength(1);
});
