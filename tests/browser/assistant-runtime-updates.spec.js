import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
async function setup(page, { malformed = false } = {}) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = {
    actions: [],
    status: {
      phase: "idle",
      currentVersion: "2026.9.8",
      targetVersion: "2026.10.1",
      candidateReady: false,
      updateAvailable: true,
      affectedAssistants: 2,
      affectedTeamMembers: 10,
      blockers: [],
      diagnostic: null,
      recoveryRequired: false,
      busy: false,
    },
  };
  await page.route("**/api/assistant-feature", fulfillEnabledAssistantFeature);
  await page.route("**/api/assistant-runtime/updates**", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    if (route.request().method() === "POST") {
      state.actions.push(action);
      if (action === "stage")
        Object.assign(state.status, { phase: "staged", candidateReady: true });
      if (action === "activate")
        Object.assign(state.status, { phase: "complete", currentVersion: "2026.10.1" });
      if (action === "recover")
        Object.assign(state.status, {
          phase: "rolled_back",
          currentVersion: "2026.9.8",
          recoveryRequired: false,
          diagnostic: "UPDATE_ROLLED_BACK",
        });
    }
    await route.fulfill({ json: malformed ? {} : state.status });
  });
  return state;
}
test("malformed update status does not crash runtime settings or enable an update", async ({
  page,
}) => {
  await setup(page, { malformed: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(baseURL + "/settings/assistants");
  await expect(page.getByText("Request failed (503)", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "OpenClaw updates" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent service" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stage update" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("owner stages and activates an update, then continues recovery on mobile", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/settings/assistants");
  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "OpenClaw updates" }) });
  await expect(panel.getByText("2 agents affected (+10 team members)")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Activate update" })).toBeDisabled();
  await panel.getByRole("button", { name: "Stage update" }).click();
  await expect(panel.getByText("Staged", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Activate update" }).click();
  await expect(panel.getByText("Update complete", { exact: true })).toBeVisible();
  expect(state.actions).toEqual(["stage", "activate"]);
  Object.assign(state.status, {
    phase: "recovery_required",
    recoveryRequired: true,
    diagnostic: "UPDATE_RECOVERY_REQUIRED",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(panel.getByRole("button", { name: "Stage update" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Activate update" })).toBeDisabled();
  await panel.getByRole("button", { name: "Continue recovery" }).click();
  await expect(
    panel.getByText("Previous version restored", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Continue recovery" })).toHaveCount(0);
  expect(state.actions).toEqual(["stage", "activate", "recover"]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
test("update status makes active work and recovery blockers visible", async ({
  page,
}) => {
  const state = await setup(page);
  Object.assign(state.status, {
    phase: "staged",
    candidateReady: true,
    blockers: ["pending-chat"],
    diagnostic: "UPDATE_BLOCKED",
  });
  await page.goto(baseURL + "/settings/assistants");
  await expect(
    page.getByText(
      "Active or unresolved work blocks activation. Review chats, tasks and deliveries.",
    ),
  ).toBeVisible();
  state.status.busy = true;
  state.status.phase = "draining";
  await expect(page.getByText("Draining work", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate update" })).toBeDisabled();
});
test("an installation already on the qualified version cannot stage it again", async ({
  page,
}) => {
  const state = await setup(page);
  Object.assign(state.status, { targetVersion: "2026.9.8", updateAvailable: false });
  await page.goto(baseURL + "/settings/assistants");
  await expect(page.getByText("The qualified version is already active.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stage update" })).toBeDisabled();
  Object.assign(state.status, {
    phase: "rolled_back",
    diagnostic: "SNAPSHOT_FAILED",
    diagnosticPath: "workspaces/project/locked.txt",
  });
  await page.reload();
  await expect(
    page.getByText("The backup could not include the file shown below.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText("workspaces/project/locked.txt")).toBeVisible();
});
