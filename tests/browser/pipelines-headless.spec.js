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
