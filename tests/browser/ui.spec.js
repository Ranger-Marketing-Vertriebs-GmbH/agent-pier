import { navigateTo } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";

test.use({ channel: process.env.TUIUI_BROWSER_CHANNEL || undefined });

import { baseURL as base } from "../helpers/browser.js";
async function fixture(page) {
  const state = {
    tools: [
      { id: "codex", name: "Codex", installed: true, path: "/bin/codex" },
      {
        id: "claude",
        name: "Claude Code",
        installed: true,
        path: "/bin/claude",
      },
      { id: "opencode", name: "OpenCode", installed: false, path: null },
    ],
    accounts: [
      {
        id: "local-codex",
        name: "Lokales Konto",
        tool: "codex",
        kind: "local",
        hasSecret: false,
        createdAt: "2026-09-06T10:00:00Z",
      },
    ],
    sessions: [],
    home: "/home/test",
    remoteUrl: null,
  };
  const input = [];
  const sockets = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    const data = req.postDataJSON();
    let result = {};
    if (path === "/api/state") result = state;
    else if (path === "/api/ssh-accesses") result = { accesses: [] };
    else if (path === "/api/directories")
      result = {
        path: url.searchParams.get("path"),
        parent: "/home",
        entries: [{ name: "project", path: "/home/test/project" }],
      };
    else if (path.endsWith("/auth-status"))
      result = { state: path.includes("/local-") ? "authenticated" : "unknown" };
    else if (path.endsWith("/chat"))
      result = {
        availability: "ready",
        providerSessionId: "native-fixture",
        messages: [{ id: "m1", role: "assistant", text: "Welcome to the chat" }],
        tasks: [],
      };
    else if (path.endsWith("/screen"))
      result = { text: "Welcome to the terminal\nReady for input >" };
    else if (path.endsWith("/input")) {
      input.push(data);
      result = { deliveryId: data.deliveryId, status: "handed-off" };
    } else if (path === "/api/accounts") {
      result = {
        id: "managed-1",
        ...data,
        kind: "managed",
        hasSecret: Boolean(data.apiKey),
        createdAt: "2026-09-06T10:00:00Z",
      };
      delete result.apiKey;
      state.accounts.push(result);
    } else if (path.endsWith("/login")) {
      result = {
        id: "session-login",
        name: "Anmeldung · Arbeit",
        accountId: "managed-1",
        tool: "codex",
        cwd: "/home/test",
        status: "running",
        createdAt: "2026-09-06T10:00:00Z",
      };
      state.sessions.push(result);
    } else if (path === "/api/sessions") {
      result = {
        id: "session-1",
        ...data,
        tool: state.accounts.find((a) => a.id === data.accountId).tool,
        status: "running",
        createdAt: "2026-09-06T10:00:00Z",
      };
      state.sessions.push(result);
    } else if (path.endsWith("/stop"))
      state.sessions.find((s) => path.includes(s.id)).status = "stopped";
    else if (path.startsWith("/api/sessions/")) {
      const session = state.sessions.find((s) => path.endsWith(s.id));
      if (req.method() === "DELETE")
        state.sessions = state.sessions.filter((s) => s !== session);
      if (req.method() === "PATCH") Object.assign(session, data);
      result = session || {};
    } else if (path.startsWith("/api/accounts/")) {
      const account = state.accounts.find((a) => path.endsWith(a.id));
      if (req.method() === "DELETE")
        state.accounts = state.accounts.filter((a) => a !== account);
      if (req.method() === "PATCH") Object.assign(account, data);
      result = account || {};
    }
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (ws) => {
    sockets.push(ws);
    ws.send(
      JSON.stringify({
        type: "output",
        data: "\x1b[32mWelcome to the terminal\x1b[0m\r\nReady for input >",
      }),
    );
    ws.onMessage((message) => {
      const data = JSON.parse(message);
      if (data.type === "input") input.push(data);
    });
  });
  return { state, input, sockets };
}

test("account creation, directory selection, session lifecycle and reload preserve user work", async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.goto(base);
  await expect(
    page.getByRole("heading", { name: "Dein Terminal. Überall." }),
  ).toBeVisible();
  await navigateTo(page, "Konten");
  await page.getByRole("button", { name: "Konto hinzufügen" }).click();
  await page.getByLabel("Kontoname").fill("Arbeit");
  await page.getByLabel("API-Key (optional)").fill("never-return-me");
  await page.getByRole("button", { name: "Konto erstellen" }).click();
  await expect(page.getByText("Arbeit", { exact: true })).toBeVisible();
  await expect(page.getByText("never-return-me")).toHaveCount(0);
  await page.getByRole("button", { name: "Neue Sitzung", exact: true }).first().click();
  await page.getByLabel("Name der Sitzung").fill("Review");
  await page.getByLabel("Zugang", { exact: true }).selectOption("managed-1");
  await page.getByRole("button", { name: "Ordner auswählen" }).click();
  await page.getByRole("button", { name: "project", exact: true }).click();
  await page.getByRole("button", { name: "Diesen Ordner verwenden" }).click();
  await page.getByRole("button", { name: "Sitzung starten", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  expect(state.sessions[0].cwd).toBe("/home/test/project");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sitzung umbenennen" }).click();
  await page.getByLabel("Neuer Name").fill("Review final");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Review final", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sitzung stoppen" }).click();
  await page.getByRole("button", { name: "Jetzt stoppen" }).click();
  await expect(page.getByRole("button", { name: "Sitzung entfernen" })).toBeVisible();
  await page.getByRole("button", { name: "Sitzung entfernen" }).click();
  await page.getByRole("button", { name: "Jetzt entfernen" }).click();
  await expect(
    page.getByRole("heading", { name: "Dein Terminal. Überall." }),
  ).toBeVisible();
});

test("mobile reader submits text explicitly and full terminal keyboard remains available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { state, input } = await fixture(page);
  state.sessions.push({
    id: "session-mobile",
    name: "Mobile Arbeit",
    tool: "codex",
    accountId: "local-codex",
    cwd: "/home/test",
    status: "running",
    createdAt: "2026-09-06T10:00:00Z",
  });
  await page.goto(base + "/#session-mobile");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("Chatverlauf")).toContainText("Welcome to the chat");
  await page.getByRole("textbox", { name: "Nachricht", exact: true }).fill("hello world");
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  await expect
    .poll(() => input)
    .toContainEqual({
      text: "hello world",
      submit: true,
      deliveryId: expect.any(String),
      deliveryScope: JSON.stringify([
        "session-mobile",
        "local-codex",
        "codex",
        "2026-09-06T10:00:00Z",
      ]),
    });
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Escape senden" }).click();
  await expect
    .poll(() => input.some((m) => m.type === "input" && m.data === "\u001b"))
    .toBeTruthy();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});

test("failed account submission preserves input, then account editing and deletion work", async ({
  page,
}) => {
  await fixture(page);
  await page.goto(base);
  await navigateTo(page, "Konten");
  await page.getByRole("button", { name: "Konto hinzufügen" }).click();
  await page.getByLabel("Kontoname").fill("Team");
  await page.route(
    "**/api/accounts",
    (route) =>
      route.fulfill({
        status: 409,
        json: { error: "Profil konnte nicht erstellt werden" },
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Konto erstellen" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Profil konnte nicht erstellt werden",
  );
  await expect(page.getByLabel("Kontoname")).toHaveValue("Team");
  await page.getByRole("button", { name: "Konto erstellen" }).click();
  await page.getByRole("button", { name: "Team bearbeiten" }).click();
  await page.getByLabel("Kontoname").fill("Team privat");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Team privat", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Team privat löschen" }).click();
  await page.getByRole("button", { name: "Konto löschen", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Team privat", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Lokales Konto", exact: true }),
  ).toBeVisible();
});

test("native login opens a visible terminal and a closed socket reconnects", async ({
  page,
}) => {
  const { state, sockets, input } = await fixture(page);
  state.accounts.push({
    id: "managed-1",
    name: "Arbeit",
    tool: "codex",
    kind: "managed",
    hasSecret: false,
    createdAt: "2026-09-06T10:00:00Z",
  });
  await page.goto(base);
  await navigateTo(page, "Konten");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await page.getByRole("button", { name: "Anmeldeterminal öffnen", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Anmeldung · Arbeit", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Verbunden");
  const connections = sockets.length;
  sockets.at(-1).close();
  await expect(page.getByRole("status")).toContainText("Verbindung getrennt");
  await expect.poll(() => sockets.length).toBeGreaterThan(connections);
  await expect(page.getByRole("status")).toHaveText("Verbunden");
  await page.getByRole("button", { name: "Enter senden" }).click();
  await expect
    .poll(() => input.some((m) => m.type === "input" && m.data === "\r"))
    .toBeTruthy();
});

test("reader preserves failed input and its error while terminal output refreshes", async ({
  page,
}) => {
  const { state } = await fixture(page);
  state.sessions.push({
    id: "session-input",
    name: "Input",
    tool: "claude",
    accountId: "local-codex",
    cwd: "/home/test",
    status: "running",
    createdAt: "2026-09-06T10:00:00Z",
  });
  await page.goto(base + "/#session-input");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("Chatverlauf")).toContainText("Welcome");
  await page.route("**/api/sessions/*/input", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Eingabe konnte nicht gesendet werden" },
    }),
  );
  await page
    .getByRole("textbox", { name: "Nachricht", exact: true })
    .fill("Keep my text");
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Eingabe konnte nicht gesendet werden",
  );
  await page.waitForResponse("**/api/sessions/*/chat");
  await expect(page.getByRole("textbox", { name: "Nachricht", exact: true })).toHaveValue(
    "Keep my text",
  );
  await expect(page.getByRole("alert")).toContainText(
    "Eingabe konnte nicht gesendet werden",
  );
});

test("reader renders Markdown code without terminal chrome or horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { state } = await fixture(page);
  state.sessions.push({
    id: "session-code",
    name: "Code",
    tool: "codex",
    accountId: "local-codex",
    cwd: "/home/test",
    status: "running",
  });
  await page.route("**/api/sessions/*/chat", (route) =>
    route.fulfill({
      json: {
        availability: "ready",
        providerSessionId: "native",
        messages: [
          {
            id: "m",
            role: "assistant",
            text: "Änderungen geprüft.\n\n```js\n  const x = 1;\n\n  return x;\n```",
          },
        ],
        tasks: [],
      },
    }),
  );
  await page.goto(base + "/#session-code");
  await expect(page.getByLabel("Chatverlauf")).toContainText("Änderungen geprüft.");
  await expect(page.locator(".message-content pre code")).toHaveText(
    "  const x = 1;\n\n  return x;\n",
  );
  await expect(page.getByLabel("Chatverlauf")).not.toContainText("Ready for input");
  await expect(page.getByLabel("Interaktives Terminal")).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
