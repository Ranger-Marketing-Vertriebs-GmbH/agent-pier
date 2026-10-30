import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

// Remembered approvals of project m1, answered like the server (requests routes).
function approvals() {
  const state = {
    deleted: [],
    rules: [
      {
        id: "rule-project",
        scope: "project",
        target: "m1",
        cli: "claude",
        tool: "Bash",
        program: "git push",
      },
      {
        id: "rule-session",
        scope: "session",
        target: "s-1",
        projectId: "m1",
        cli: "codex",
        tool: "item/fileChange/requestApproval",
        sessionName: "Refactor",
      },
    ],
  };
  const intercept = async (route, url, method) => {
    if (url.pathname === "/api/remembered-approvals") {
      state.project = url.searchParams.get("project");
      await route.fulfill({ json: { rules: state.rules } });
      return true;
    }
    const match = /^\/api\/remembered-approvals\/([^/]+)$/.exec(url.pathname);
    if (!match || method !== "DELETE") return false;
    state.deleted.push(match[1]);
    state.rules = state.rules.filter((rule) => rule.id !== match[1]);
    await route.fulfill({ json: { removed: match[1] } });
    return true;
  };
  return { state, intercept };
}

test("the Approvals tab lists remembered approvals and removes one", async ({ page }) => {
  const access = approvals();
  await hubFixture(page, { intercept: access.intercept });
  await page.goto(base + "/projects/m1?tab=approvals");
  await expect(page.getByRole("tab", { name: "Freigaben" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const project = page.getByRole("group", { name: "Dieses Projekt" });
  await expect(project.getByText("git push", { exact: true })).toBeVisible();
  await expect(project.getByText("Claude Code", { exact: true })).toBeVisible();
  const sessions = page.getByRole("group", { name: "Einzelne Sessions" });
  await expect(sessions.getByText("Dateiänderungen", { exact: true })).toBeVisible();
  await expect(sessions.getByText("Codex · Session Refactor")).toBeVisible();
  expect(access.state.project).toBe("m1");
  await page.getByRole("button", { name: "Freigabe für git push entfernen" }).click();
  await expect(project).toHaveCount(0);
  expect(access.state.deleted).toEqual(["rule-project"]);
});

test.describe("English project approvals", () => {
  test.use({ locale: "en-GB" });
  test("an empty Approvals tab explains how approvals are remembered", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const access = approvals();
    access.state.rules = [];
    await hubFixture(page, { intercept: access.intercept });
    await page.goto(base + "/projects/m1?tab=approvals");
    await expect(page.getByText(/No remembered approvals yet/)).toBeVisible();
    await expect(
      page.getByText(/such as git status or npm test, never ask/),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });
});
