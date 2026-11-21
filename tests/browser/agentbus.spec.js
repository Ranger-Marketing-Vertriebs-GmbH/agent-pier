import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";

// The message log of a project whose bus holds `total` messages, one of them listed.
async function oneMessageLog(page, total) {
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
            { id: "demo", name: "Website", cwd: "/fixture/Website", sessions: [] },
          ],
        },
      });
    if (url.pathname === "/api/agentbus/projects/demo/messages")
      return route.fulfill({
        json: {
          projectId: "demo",
          page: 1,
          pageSize: 20,
          total,
          items: [
            {
              id: "m1",
              from: { name: "Claude review", tool: "claude", key: "claude:a" },
              to: { name: "Codex build", tool: "codex", key: "codex:b" },
              text: "Done",
              createdAt: "2026-11-20T21:00:00.000Z",
              status: "read",
            },
          ],
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/projects/demo?tab=agentbus&bus=messages`);
  return page.locator(".section-heading > span");
}

test("the message log counts one entry in the singular", async ({ page }) => {
  const count = await oneMessageLog(page, 1);
  await expect(count).toHaveText("1 Eintrag");
});
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
    if (url.pathname === "/api/agentbus/projects/demo/messages")
      return route.fulfill({
        json: {
          projectId: "demo",
          page: Number(url.searchParams.get("page") || 1),
          pageSize: 20,
          // Deliberately different from the status poll's pending-inbox total (2), to
          // prove the segment count comes from the message log, not the status data.
          total: 3,
          items: [],
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(base + "/projects?tab=agentbus");
  await expect(page).toHaveURL(/\/projects\/demo\?tab=agentbus$/);
  await expect(page.getByRole("heading", { name: "Website", exact: true })).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Sessions · 2", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Nachrichten · 3", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "1 verbunden" })).toBeVisible();
  await expect(page.getByText("2 Nachrichten warten · Version 0.1.0")).toBeVisible();
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
    codexSession.getByText("Wartet auf Registrierung", { exact: true }),
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

test("the status poll is not duplicated, and the message count is read once, while the AgentBus tab is open", async ({
  page,
}) => {
  let agentbusCalls = 0,
    messagesCalls = 0;
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
    if (url.pathname === "/api/agentbus/projects/demo/messages") {
      messagesCalls += 1;
      return route.fulfill({
        json: { projectId: "demo", page: 1, pageSize: 20, total: 0, items: [] },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(base + "/projects?tab=agentbus");
  await expect(page).toHaveURL(/\/projects\/demo\?tab=agentbus$/);
  await page.waitForTimeout(9000);
  // One initial load plus at most two 4 s polling ticks; a duplicate poller would double this.
  expect(agentbusCalls).toBeLessThanOrEqual(4);
  // The message count is read once on mount, not polled, while the status segment stays open.
  expect(messagesCalls).toBe(1);
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
      "Noch keine Sessions mit AgentBus. Starte eine neue Coding-CLI-Session.",
    ),
  ).toBeVisible();
  await page.getByRole("radio", { name: /^Nachrichten/ }).check();
  await expect(
    page.getByText("In diesem Projekt sind noch keine AgentBus-Nachrichten vorhanden."),
  ).toBeVisible();
});

test.describe("English AgentBus status", () => {
  test.use({ locale: "en-GB" });

  test("the message log counts one entry in the singular", async ({ page }) => {
    const count = await oneMessageLog(page, 1);
    await expect(count).toHaveText("1 entry");
  });

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
                    reason: "Diese Session muss neu geladen werden.",
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
    await expect(session).not.toContainText("Waiting for registration");
    await expect(session).not.toContainText("Diese Session");
    await page.screenshot({
      path: `.cache/review-fixes/agentbus-reload-required-${browserName}.png`,
      fullPage: true,
    });
  });

  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ])
    test(`server notes and registration reasons are English at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
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
              note: "Nur aktivierte AgentPier-Sessions im selben Projekt tauschen Nachrichten aus. Diese Übersicht liest keine Nachrichten und markiert nichts als gelesen. Codex kann eine native Prüfung neuer Hooks verlangen.",
              noteKey: "agentbus.overviewNotice",
              projects: [
                {
                  id: "demo",
                  name: "Website",
                  cwd: "/fixture/Website",
                  sessions: [
                    {
                      id: "pending",
                      name: "Codex Review",
                      tool: "codex",
                      status: "running",
                      registered: false,
                      pending: 0,
                      reason:
                        "Noch nicht registriert. Falls Codex Hooks zur Prüfung meldet, /hooks öffnen und die AgentBus-Hooks prüfen.",
                      reasonKey: "agentbus.codexRegistrationPending",
                    },
                  ],
                },
              ],
            },
          });
        return route.fulfill({ json: {} });
      });
      await page.goto(`${base}/projects/demo?tab=agentbus`);
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(
        page.getByText(/^Only enabled AgentPier sessions in the same project/),
      ).toBeVisible();
      const session = page
        .getByRole("article")
        .filter({ has: page.getByRole("heading", { name: "Codex Review" }) });
      await expect(
        session.getByText("Waiting for registration", { exact: true }),
      ).toBeVisible();
      await expect(session.getByText(/^Not registered yet\. If Codex/)).toBeVisible();
      await expect(page.locator("main")).not.toContainText("Nur aktivierte");
      await expect(session).not.toContainText("Noch nicht");
      await expect(session).not.toContainText("sign-in");
    });

  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ])
    test(`a page past the end shows the last page with status chips at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      const pages = [];
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
                { id: "demo", name: "Website", cwd: "/fixture/Website", sessions: [] },
              ],
            },
          });
        if (url.pathname === "/api/agentbus/projects/demo/messages") {
          pages.push(Number(url.searchParams.get("page")));
          // The server clamps a page past the end to the last one.
          return route.fulfill({
            json: {
              projectId: "demo",
              page: 2,
              pageSize: 20,
              total: 22,
              items: [
                {
                  id: "m1",
                  from: { name: "Claude review", tool: "claude", key: "claude:a" },
                  to: { name: "Codex build", tool: "codex", key: "codex:b" },
                  text: "Done",
                  createdAt: "2026-11-20T21:00:00.000Z",
                  status: "read",
                },
              ],
            },
          });
        }
        return route.fulfill({ json: {} });
      });
      await page.goto(`${base}/projects/demo?tab=agentbus&bus=messages&page=99`);
      const message = page.getByRole("article").filter({ hasText: "Done" });
      await expect(message).toContainText("Claude review");
      await expect(message.locator(".status-chip")).toHaveText("Retrieved");
      await expect(page.getByText("Page 2 / 2")).toBeVisible();
      await expect(page.locator(".section-heading > span")).toHaveText("22 entries");
      await expect(page.getByRole("button", { name: /next page/i })).toBeDisabled();
      expect(pages[0]).toBe(99);
    });
});
