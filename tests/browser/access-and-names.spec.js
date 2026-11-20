import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";

// How AgentPier is reached shows in the sidebar badge and the start page footer
// (AGENTPIER-390); names AgentPier generates follow the UI language (AGENTPIER-400).
async function withState(page, extra) {
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, ...extra(json) } });
  });
}

test("network access with other users shows in the badge and the footer", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await withState(page, () => ({
    access: { network: true, tailscale: true, users: 2 },
  }));
  await page.goto(baseURL);
  await expect(page.locator(".local-badge")).toHaveText("NETWORK");
  await expect(page.locator(".start-footer")).toContainText(
    "Reachable on the network · you and 2 other users have access",
  );
});

test("a local instance without users keeps LOCAL and only you", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await withState(page, () => ({
    access: { network: false, tailscale: false, users: 0 },
  }));
  await page.goto(baseURL);
  await expect(page.locator(".local-badge")).toHaveText("LOCAL");
  await expect(page.locator(".start-footer")).toContainText(
    "Runs locally · only you have access",
  );
});

test("generated account and sign-in names show in English", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await withState(page, (state) => ({
    sessions: [
      {
        id: "login-1",
        name: "Work · Anmeldung",
        nameKey: "sessions.loginName",
        nameArgs: ["Work"],
        tool: "codex",
        accountId: "local-codex",
        cwd: state.home,
        status: "running",
        purpose: "login",
        createdAt: new Date().toISOString(),
      },
    ],
  }));
  await page.goto(baseURL);
  const sidebar = page.locator("aside.sidebar");
  await expect(sidebar.getByText("Work · Sign-in")).toBeVisible();
  await expect(sidebar.getByText("Work · Anmeldung")).toHaveCount(0);
});
