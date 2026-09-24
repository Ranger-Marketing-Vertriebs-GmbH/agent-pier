import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture, hubRun } from "./projects-fixture.js";

const projectList = (page, name = "Projekte") =>
  page.getByRole("navigation", { name, exact: true });
const statusCalls = (calls) =>
  calls.filter(
    (call) => call.path === "/api/pipeline-runs" && call.search.includes("status="),
  ).length;
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

test("saving a knowledge entry does not sweep the run hints again", async ({ page }) => {
  const calls = await hubFixture(page);
  await page.goto(base + "/projects/m1?tab=knowledge");
  await expect(projectList(page).getByRole("button", { name: /^notes/ })).toContainText(
    "2 Läufe fehlgeschlagen",
  );
  expect(statusCalls(calls)).toBe(2);
  const repositoryReads = reads(calls, "/api/repositories");
  await page.getByRole("button", { name: "Neuer Eintrag" }).click();
  const dialog = page.getByRole("dialog", { name: "Neuer Eintrag" });
  await dialog.getByLabel("Titel").fill("Hub entry");
  await dialog.getByLabel("Inhalt").fill("Saved from the hub");
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toHaveCount(0);
  // The hub reloads its sources, but not the status-filtered run listings.
  await expect
    .poll(() => reads(calls, "/api/repositories"))
    .toBeGreaterThan(repositoryReads);
  await page.waitForTimeout(500);
  expect(statusCalls(calls)).toBe(2);
});

test("the hub retry sweeps the run hints again", async ({ page }) => {
  const controls = { failMemory: true };
  const calls = await hubFixture(page, controls);
  await page.goto(base + "/projects");
  await expect(page.getByRole("alert")).toContainText("Wissen nicht erreichbar");
  await expect.poll(() => statusCalls(calls)).toBe(2);
  controls.failMemory = false;
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => statusCalls(calls)).toBe(4);
});

test("run hints beyond the swept pages read as a lower bound", async ({ page }) => {
  const runs = Array.from({ length: 130 }, (_, index) =>
    hubRun(`f${index}`, "m2", "failed"),
  );
  await hubFixture(page, { runs: [hubRun("a", "m1", "awaiting-human"), ...runs] });
  await page.goto(base + "/projects");
  const list = projectList(page);
  await expect(list.getByRole("button", { name: /^notes/ })).toContainText(
    "100+ Läufe fehlgeschlagen",
  );
  await expect(list.getByRole("button", { name: /^agent-pier/ })).toContainText(
    "1 Entscheidung erforderlich",
  );
});
