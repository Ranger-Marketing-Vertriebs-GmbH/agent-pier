import { test, expect } from "@playwright/test";
import { pipelinesFixture } from "./pipelines-fixture.js";
import { baseURL } from "../helpers/browser.js";

for (const width of [1440, 390]) {
  test(`finished autonomous sessions leave the sidebar but retain history at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await pipelinesFixture(page);
    const session = (id, name, status, pipeline) => ({
      id,
      name,
      status,
      pipeline,
      tool: "codex",
      accountId: "local-codex",
      cwd: "/fixture/project",
    });
    state.sessions.push(
      session("finished", "Finished worker", "stopped", {
        headless: true,
        runId: "run-one",
      }),
      session("active", "Active worker", "running", { headless: true, runId: "run-one" }),
      session("manual", "My conversation", "stopped"),
      session("interactive", "Interactive profile", "stopped", { headless: false }),
    );
    state.runs.push({
      id: "run-one",
      status: "completed",
      nodes: [],
      actions: ["delete"],
    });
    await page.goto(baseURL + "/sessions/finished/chat");
    await expect(
      page.getByRole("heading", { name: "Finished worker", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Zum Pipeline-Lauf", exact: true }),
    ).toBeVisible();
    const sidebar = page.locator(".sidebar");
    await expect(sidebar.locator(".session-item")).toHaveCount(3);
    await expect(sidebar.locator(".session-item")).not.toContainText(["Finished worker"]);
    await expect(sidebar.locator(".sessions-group .sidebar-group-count")).toHaveText(
      "03",
    );
    if (width === 390)
      await page.getByRole("button", { name: "Navigation öffnen" }).click();
    await expect(sidebar.getByRole("button", { name: /Active worker/ })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: /My conversation/ })).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: /Interactive profile/ }),
    ).toBeVisible();
    if (width === 390) {
      await expect
        .poll(() =>
          sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().left)),
        )
        .toBe(0);
      await page.screenshot({ path: "test-results/pipeline-session-list-mobile.png" });
    }
    state.sessions.find((item) => item.id === "active").status = "stopped";
    await page.reload();
    await expect(sidebar.locator(".session-item")).toHaveCount(2);
    await expect(sidebar.locator(".sessions-group .sidebar-group-count")).toHaveText(
      "02",
    );
    await expect(
      page.getByRole("heading", { name: "Finished worker", exact: true }),
    ).toBeVisible();
    expect(state.calls.some((call) => call.method === "DELETE")).toBe(false);
  });
}
