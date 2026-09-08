import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
test("mobile imported AgentBus history is paginated and never exposes message delivery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await operationsFixture(page);
  state.importedProjects = [{ id: "imported-project", historyOnly: true }];
  state.importedMessages = Array.from({ length: 21 }, (_, index) => ({
    id: `message-${index}`,
    text: `Imported fixture message ${index}`,
    createdAt: "2026-09-07T12:00:00Z",
    from: { name: "Planner", tool: "claude" },
    to: { name: "Reviewer", tool: "codex" },
    status: index === 20 ? "pending-at-backup" : "read",
    historyOnly: true,
  }));
  await page.goto(baseURL + "/settings/backups");
  await expect(
    page.getByRole("heading", { name: "Importierter AgentBus-Verlauf", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Importiertes Projekt", { exact: true })
    .selectOption("imported-project");
  await expect(
    page.getByText("Imported fixture message 0", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Importierter AgentBus-Verlauf: Nächste Seite",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Imported fixture message 20", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Imported fixture message 0", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Zum Sicherungszeitpunkt noch ausstehend", { exact: true }),
  ).toBeVisible();
  expect(
    state.calls.some(
      (call) => call.path.includes("imported-history") && call.method !== "GET",
    ),
  ).toBe(false);
  await expect(
    page.getByRole("button", { name: "Nachricht senden", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
