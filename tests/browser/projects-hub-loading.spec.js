import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

const projectList = (page, name = "Projekte") =>
  page.getByRole("navigation", { name, exact: true });
const reads = (calls, path) =>
  calls.filter((call) => call.method === "GET" && call.path === path).length;

test("a slow source does not bring back an AgentBus error a newer poll cleared", async ({
  page,
}) => {
  test.setTimeout(30000);
  let busReads = 0,
    busAnswers = 0,
    release;
  const memoryHeld = new Promise((resolve) => (release = resolve));
  const calls = await hubFixture(page, {
    intercept: async (route, url, method) => {
      if (url.pathname === "/api/agentbus" && ++busReads === 1) {
        await route.fulfill({
          status: 503,
          json: { error: "AgentBus nicht erreichbar" },
        });
        busAnswers++;
        return true;
      }
      if (url.pathname === "/api/agentbus") {
        setTimeout(() => busAnswers++, 0);
        return false;
      }
      if (url.pathname === "/api/memory/projects" && method === "GET") await memoryHeld;
      return false;
    },
  });
  await page.goto(base + "/projects");
  // The initial load waits on the knowledge source; the 4 s poll answers meanwhile.
  await expect.poll(() => busAnswers, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(300);
  await expect(page.getByRole("alert")).toHaveCount(0);
  release();
  const list = projectList(page);
  await expect(list.getByRole("button", { name: /^notes/ })).toBeVisible();
  // Checked once, without waiting: a later poll would hide a reverted error again.
  expect(await page.getByRole("alert").count()).toBe(0);
  expect(reads(calls, "/api/agentbus")).toBeGreaterThanOrEqual(2);
});
