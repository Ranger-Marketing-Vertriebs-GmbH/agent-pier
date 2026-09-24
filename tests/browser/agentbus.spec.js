import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
test("bundled AgentBus status groups this project's sessions without consuming inboxes", async ({
  page,
}) => {
  const calls = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    calls.push({ path: url.pathname, method: req.method() });
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: { accounts: [], tools: [], sessions: [], home: "/fixture" },
      });
    if (url.pathname === "/api/agentbus")
      return route.fulfill({
        json: {
          bundled: true,
          version: "0.1.0",
          note: "Inbox-Inhalte werden hier nicht gelesen.",
          projects: [
            {
              id: "demo",
              name: "Website",
              cwd: "/fixture/Website",
              sessions: [
                {
                  id: "one",
                  name: "Claude Arbeit",
                  tool: "claude",
                  status: "running",
                  registered: true,
                  pending: 2,
                },
                {
                  id: "two",
                  name: "Codex Review",
                  tool: "codex",
                  status: "running",
                  registered: false,
                  pending: 0,
                  reason: "Wartet auf nativen Hook.",
                },
              ],
            },
          ],
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(base + "/projects?tab=agentbus");
  await expect(page).toHaveURL(/\/projects\/demo\?tab=agentbus$/);
  await expect(page.getByRole("heading", { name: "Website", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Sitzungen/ })).toContainText("2");
  await expect(page.getByRole("tab", { name: /^Nachrichten/ })).toContainText("2");
  await expect(
    page.getByText("1 verbunden · 2 Nachrichten warten · Version 0.1.0"),
  ).toBeVisible();
  await expect(page.getByText("Inbox-Inhalte werden hier nicht gelesen.")).toBeVisible();
  const claudeSession = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Claude Arbeit" }) });
  await expect(claudeSession.getByText("Verbunden", { exact: true })).toBeVisible();
  await expect(claudeSession.getByText("2 in der Inbox", { exact: true })).toBeVisible();
  const codexSession = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Codex Review" }) });
  await expect(
    codexSession.getByText("Wartet auf CLI-Anmeldung", { exact: true }),
  ).toBeVisible();
  await expect(
    codexSession.getByText("Wartet auf nativen Hook.", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  expect(calls.every((c) => c.method === "GET")).toBeTruthy();
});

test("the status poll is not duplicated while the AgentBus tab is open", async ({
  page,
}) => {
  let agentbusCalls = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: { accounts: [], tools: [], sessions: [], home: "/fixture" },
      });
    if (url.pathname === "/api/agentbus") {
      agentbusCalls += 1;
      return route.fulfill({
        json: {
          version: "0.1.0",
          note: "",
          projects: [
            { id: "demo", name: "Website", cwd: "/fixture/Website", sessions: [] },
          ],
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(base + "/projects?tab=agentbus");
  await expect(page).toHaveURL(/\/projects\/demo\?tab=agentbus$/);
  await page.waitForTimeout(9000);
  // One initial load plus at most two 4 s polling ticks; a duplicate poller would double this.
  expect(agentbusCalls).toBeLessThanOrEqual(4);
});

test("a hub project without an AgentBus id shows the existing empty texts", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: { accounts: [], tools: [], sessions: [], home: "/fixture" },
      });
    if (url.pathname === "/api/agentbus")
      return route.fulfill({ json: { version: "0.1.0", note: "", projects: [] } });
    if (url.pathname === "/api/memory/projects")
      return route.fulfill({
        json: {
          projects: [{ id: "m1", name: "notes", cwd: "/fixture/notes", entryCount: 0 }],
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(base + "/projects?tab=agentbus");
  await expect(
    page.getByText(
      "Noch keine Sitzungen mit AgentBus. Starte eine neue Coding-CLI-Sitzung.",
    ),
  ).toBeVisible();
  await page.getByRole("tab", { name: /^Nachrichten/ }).click();
  await expect(
    page.getByText("Dieses AgentBus-Projekt wurde nicht gefunden."),
  ).toBeVisible();
});

test.describe("English AgentBus status", () => {
  test.use({ locale: "en-GB" });

  test("legacy sessions show a localized reload requirement", async ({
    page,
    browserName,
  }) => {
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/state")
        return route.fulfill({
          json: { accounts: [], tools: [], sessions: [], home: "/fixture" },
        });
      if (url.pathname === "/api/agentbus")
        return route.fulfill({
          json: {
            bundled: true,
            version: "0.1.0",
            projects: [
              {
                id: "demo",
                name: "Website",
                cwd: "/fixture/Website",
                sessions: [
                  {
                    id: "legacy",
                    name: "Legacy Codex",
                    tool: "codex",
                    status: "running",
                    registered: false,
                    pending: 0,
                    reasonCode: "AGENTBUS_RELOAD_REQUIRED",
                    reason: "Diese Sitzung muss neu geladen werden.",
                  },
                ],
              },
            ],
          },
        });
      return route.fulfill({ json: {} });
    });
    await page.goto(`${base}/agentbus`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const session = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Legacy Codex" }) });
    await expect(session.getByText("Codex", { exact: true })).toBeVisible();
    await expect(session.getByText("Reload required", { exact: true })).toBeVisible();
    await expect(
      session.getByText("Reload this session to use the current AgentBus integration.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(session).not.toContainText("Waiting for CLI sign-in");
    await expect(session).not.toContainText("Diese Sitzung");
    await page.screenshot({
      path: `.cache/review-fixes/agentbus-reload-required-${browserName}.png`,
      fullPage: true,
    });
  });
});
