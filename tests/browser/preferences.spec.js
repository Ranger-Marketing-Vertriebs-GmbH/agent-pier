import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
test("settings save a default folder and explicit repository launch wins", async ({
  page,
}) => {
  const state = {
      tools: [{ id: "codex", name: "Codex", installed: true }],
      accounts: [{ id: "local-codex", tool: "codex", name: "Lokal", kind: "local" }],
      sessions: [],
      home: "/home/test",
      defaultCwd: "/home/test",
    },
    writes = [];
  await page.route("**/api/**", (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname === "/api/state") return route.fulfill({ json: state });
    if (url.pathname === "/api/preferences") {
      if (req.method() === "PATCH") {
        writes.push(req.postDataJSON());
        state.defaultCwd = req.postDataJSON().defaultCwd;
      }
      return route.fulfill({ json: { defaultCwd: state.defaultCwd } });
    }
    if (url.pathname === "/api/directories") {
      const path = url.searchParams.get("path");
      return route.fulfill({
        json: {
          path,
          parent: "/",
          entries: path === "/work" ? [] : [{ name: "work", path: "/work" }],
        },
      });
    }
    if (url.pathname === "/api/repositories")
      return route.fulfill({
        json: {
          credentials: [],
          projects: [
            {
              id: "repo",
              name: "Projekt",
              path: "/repo/project",
              url: "https://github.com/example/project.git",
              status: "ready",
            },
          ],
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(base + "/settings");
  await expect(
    page.getByRole("heading", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Standardordner auswählen" }).click();
  await page.getByRole("button", { name: "work", exact: true }).click();
  await page.getByRole("button", { name: "Diesen Ordner verwenden" }).click();
  await page.getByRole("button", { name: "Einstellungen speichern" }).click();
  await expect(page.getByRole("status")).toContainText("gespeichert");
  expect(writes).toEqual([{ defaultCwd: "/work" }]);
  await page.screenshot({
    path: "test-results/settings-default-directory.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.reload();
  await expect(
    page.getByLabel("Standard-Arbeitsverzeichnis", { exact: true }),
  ).toHaveValue("/work");
  await page.getByRole("button", { name: "Neue Sitzung", exact: true }).click();
  await expect(page.getByLabel("Arbeitsverzeichnis", { exact: true })).toHaveValue(
    "/work",
  );
  await page.getByRole("button", { name: "Dialog schließen" }).click();
  await page.getByRole("button", { name: "Repositories", exact: true }).click();
  await expect(page.getByLabel("Übergeordneter Ordner", { exact: true })).toHaveValue(
    "/work",
  );
  await page.getByRole("button", { name: "Sitzung in Projekt starten" }).click();
  await expect(page.getByLabel("Arbeitsverzeichnis", { exact: true })).toHaveValue(
    "/repo/project",
  );
});
test("shell has a terminal-only deep link and never exposes coding model or bus controls", async ({
  page,
}) => {
  const calls = [],
    state = {
      tools: [{ id: "shell", name: "Shell", installed: true }],
      accounts: [
        { id: "local-shell", tool: "shell", name: "Shell Lokal", kind: "local" },
      ],
      sessions: [
        {
          id: "shell-one",
          name: "Shell Sitzung",
          tool: "shell",
          accountId: "local-shell",
          cwd: "/tmp",
          status: "running",
        },
      ],
      home: "/tmp",
      defaultCwd: "/work",
    };
  await page.route("**/api/**", (route) => {
    const req = route.request(),
      p = new URL(req.url()).pathname;
    calls.push({
      path: p,
      method: req.method(),
      body: req.method() === "POST" ? req.postDataJSON() : null,
    });
    return route.fulfill(
      p === "/api/state"
        ? { json: state }
        : p === "/api/sessions"
          ? { status: 409, json: { error: "Launch captured" } }
          : { json: {} },
    );
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (ws) =>
    ws.send(JSON.stringify({ type: "output", data: "Shell ready" })),
  );
  await page.goto(base + "/sessions/shell-one/reader");
  await expect(page).toHaveURL(/\/sessions\/shell-one\/terminal$/);
  await expect(page.getByLabel("Interaktives Terminal")).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  expect(calls.some((c) => /\/(chat|models)(\/|$)/.test(c.path))).toBe(false);
  await page.getByRole("button", { name: "Neue Sitzung", exact: true }).click();
  await expect(page.getByLabel("Startmodus", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /AgentBus/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Sitzung starten", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Launch captured");
  expect(calls.find((c) => c.path === "/api/sessions").body).toMatchObject({
    accountId: "local-shell",
    launchMode: "default",
    agentbus: false,
    cwd: "/work",
  });
});
