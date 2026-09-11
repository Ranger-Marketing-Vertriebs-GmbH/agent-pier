import { test, expect } from "@playwright/test";

import { baseURL as base } from "../helpers/browser.js";
async function launchFixture(page) {
  const launches = [];
  const tools = ["codex", "claude", "opencode"].map((id) => ({
    id,
    name: id,
    installed: true,
    path: `/bin/${id}`,
  }));
  const accounts = tools.map(({ id }) => ({
    id: `local-${id}`,
    tool: id,
    name: id,
    kind: "local",
    hasSecret: false,
    createdAt: null,
  }));
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: { tools, accounts, sessions: [], home: "/home/test", remoteUrl: null },
    }),
  );
  await page.route("**/api/sessions", (route) => {
    launches.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: "Test launch captured" } });
  });
  await page.goto(base);
  await page.getByRole("button", { name: "Neue Sitzung", exact: true }).click();
  return launches;
}

test("new sessions default to Claude/OpenCode Auto while Codex retains Standard", async ({
  page,
}) => {
  const launches = await launchFixture(page);
  const mode = page.getByLabel("Startmodus", { exact: true });
  await expect(mode).toHaveValue("default");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sitzung starten", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("Test launch captured");
  expect(launches[0]).toMatchObject({ accountId: "local-codex", launchMode: "default" });
  await mode.selectOption("yolo");
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await expect(mode).toHaveValue("auto");
  await expect(mode.locator('option[value="yolo"]')).toHaveCount(0);
  await mode.selectOption("auto");
  await page.getByLabel("CLI", { exact: true }).selectOption("opencode");
  await expect(mode).toHaveValue("auto");
});

for (const { tool, mode, note } of [
  { tool: "codex", mode: "yolo", note: /ohne Sandbox/ },
  { tool: "claude", mode: "auto", note: /Sicherheitsprüfung/ },
  { tool: "opencode", mode: "auto", note: /Verbote bleiben/ },
])
  test(`${tool} submits its explicitly selected native launch mode`, async ({ page }) => {
    const launches = await launchFixture(page);
    await page.getByLabel("CLI", { exact: true }).selectOption(tool);
    await page.getByLabel("Startmodus", { exact: true }).selectOption(mode);
    await expect(page.locator("#launch-mode-description")).toContainText(note);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Sitzung starten", exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveText("Test launch captured");
    expect(launches[0]).toMatchObject({ accountId: `local-${tool}`, launchMode: mode });
  });

test("AgentBus is included by default and can be disabled for this launch without changing the account", async ({
  page,
}) => {
  const launches = await launchFixture(page);
  await page.locator(".launch-extensions > summary").click();
  const toggle = page.getByRole("checkbox", { name: /AgentBus/ });
  await expect(toggle).toBeChecked();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sitzung starten", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("Test launch captured");
  expect(launches[0].agentbus).toBe(true);
  await toggle.uncheck();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sitzung starten", exact: true })
    .click();
  await expect.poll(() => launches.length).toBe(2);
  expect(launches[1].agentbus).toBe(false);
  expect(launches[1].accountId).toBe(launches[0].accountId);
});
