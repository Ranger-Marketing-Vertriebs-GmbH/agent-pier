import { navigateTo } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
test("bundled AgentBus status groups project sessions without consuming inboxes", async ({
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
  await page.goto(base);
  await navigateTo(page, "AgentBus");
  await expect(
    page.getByRole("heading", { name: "AgentBus", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Website", exact: true })).toBeVisible();
  await expect(page.getByText("2 in der Inbox", { exact: true })).toBeVisible();
  await expect(page.getByText("Wartet auf nativen Hook.", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  expect(calls.every((c) => c.method === "GET")).toBeTruthy();
});
