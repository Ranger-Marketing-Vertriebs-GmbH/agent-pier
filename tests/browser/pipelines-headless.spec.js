import { test, expect } from "@playwright/test";
import { pipelinesFixture } from "./pipelines-fixture.js";
import { baseURL } from "../helpers/browser.js";
test("pipeline-owned headless sessions expose chat and terminal but direct controls stay read-only", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await pipelinesFixture(page);
  state.sessions.push({
    id: "headless",
    name: "Pipeline worker",
    tool: "codex",
    accountId: "local-codex",
    cwd: "/fixture/project",
    status: "running",
    pipeline: { headless: true, runId: "run-one" },
  });
  await page.goto(baseURL + "/sessions/headless/chat");
  await expect(
    page.getByRole("textbox", { name: "Nachricht", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Modell auswählen", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Zum Pipeline-Lauf", exact: true }),
  ).toHaveAttribute("href", "/pipelines/runs/run-one");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enter senden", exact: true }),
  ).toBeDisabled();
  expect(state.calls.some((call) => call.path.endsWith("/input"))).toBe(false);
});

test("stopped pipeline session exposes stage retry and override from its current run", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.sessions.push({
    id: "headless",
    name: "Pipeline worker",
    tool: "codex",
    accountId: "local-codex",
    cwd: "/fixture/project",
    status: "stopped",
    pipeline: { headless: true, runId: "run-one" },
  });
  state.runs.push({
    id: "run-one",
    status: "awaiting-human",
    currentNodeId: "build",
    nodes: [
      {
        id: "build",
        sessionId: "headless",
        status: "failed",
        failDetail: "Native turn failed",
      },
    ],
    actions: ["abort", "retry", "reconcile", "override"],
  });
  await page.goto(baseURL + "/sessions/headless/chat");
  await expect(
    page.getByRole("button", { name: "Stufe erneut starten", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Übergehen & fortsetzen", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Native turn failed", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/pipeline-session-recovery.png" });
  await page.getByRole("button", { name: "Stufe erneut starten", exact: true }).click();
  await expect
    .poll(() =>
      state.calls.some(
        (call) =>
          call.path === "/pipeline-runs/run-one/retry-stage" && call.method === "POST",
      ),
    )
    .toBe(true);
  expect(
    state.calls.some((call) => call.path.endsWith("/reload") && call.method === "POST"),
  ).toBe(false);
});

test("historical pipeline sessions do not control a newer stage attempt", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.sessions.push({
    id: "headless",
    name: "Old worker",
    tool: "codex",
    accountId: "local-codex",
    cwd: "/fixture/project",
    status: "stopped",
    pipeline: { headless: true, runId: "run-one" },
  });
  state.runs.push({
    id: "run-one",
    status: "awaiting-human",
    currentNodeId: "build",
    nodes: [{ id: "build", sessionId: "new-worker", status: "failed" }],
    actions: ["abort", "retry", "override"],
  });
  await page.goto(baseURL + "/sessions/headless/chat");
  await expect
    .poll(() => state.calls.some((call) => call.path === "/pipeline-runs/run-one"))
    .toBe(true);
  await expect(
    page.getByRole("link", { name: "Zum Pipeline-Lauf", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stufe erneut starten", exact: true }),
  ).toHaveCount(0);
});
