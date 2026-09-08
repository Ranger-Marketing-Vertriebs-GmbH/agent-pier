import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function fixture(page) {
  const state = {
    home: "/fixture",
    defaultCwd: "/fixture",
    defaultAccountIds: {},
    tools: [{ id: "claude", name: "Claude Code", installed: true }],
    accounts: [
      { id: "local-claude", name: "Server Claude", tool: "claude", kind: "local" },
      {
        id: "managed-claude",
        name: "Work Claude",
        tool: "claude",
        kind: "managed",
        hasSecret: false,
      },
    ],
    sessions: [],
  };
  const authStates = { "managed-claude": "authenticated" };
  const launches = [];
  await page.route("**/api/**", (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    let result = {};
    if (endpoint === "/api/state") result = state;
    else if (endpoint === "/api/ssh-accesses") result = { accesses: [] };
    if (endpoint.endsWith("/auth-status"))
      result = {
        state: authStates[endpoint.split("/")[3]] || "unauthenticated",
        checkedAt: Date.now(),
      };
    if (endpoint === "/api/preferences") {
      if (route.request().method() === "PATCH")
        Object.assign(
          state.defaultAccountIds,
          route.request().postDataJSON().defaultAccountIds,
        );
      result = {
        defaultAccountIds: state.defaultAccountIds,
        defaultCwd: state.defaultCwd,
      };
    }
    if (endpoint === "/api/sessions" && route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      launches.push(body);
      result = { ...body, id: "started", tool: "claude", status: "running" };
      state.sessions.push(result);
    }
    return route.fulfill({ json: result });
  });
  await page.routeWebSocket("**/terminal", () => {});
  return { state, launches, authStates };
}

test("signed-in Claude account replaces login action and becomes the persistent launch default", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(baseURL + "/accounts");
  const card = page
    .locator(".account-card")
    .filter({ has: page.getByRole("heading", { name: "Work Claude", exact: true }) });
  await expect(card.getByText("Angemeldet", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Anmelden", exact: true })).toHaveCount(
    0,
  );
  await card
    .getByRole("button", { name: "Work Claude als Standard verwenden", exact: true })
    .click();
  await expect.poll(() => f.state.defaultAccountIds.claude).toBe("managed-claude");
  await page.reload();
  await expect(card.getByText("Standardkonto", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Neue Sitzung", exact: true }).first().click();
  await expect(page.getByRole("combobox", { name: "Zugang", exact: true })).toHaveValue(
    "managed-claude",
  );
  await expect(
    page.getByRole("combobox", { name: "Startmodus", exact: true }),
  ).toHaveValue("auto");
});

for (const tool of ["claude", "codex", "opencode"])
  test(`local ${tool} is only shown with a confirmed login`, async ({ page }) => {
    const f = await fixture(page);
    f.state.accounts[0] = { id: `local-${tool}`, name: "Local CLI", tool, kind: "local" };
    await page.goto(baseURL + "/accounts");
    await expect(
      page.getByRole("heading", { name: "Work Claude", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Local CLI", exact: true }),
    ).toHaveCount(0);
    f.authStates[`local-${tool}`] = "authenticated";
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Local CLI", exact: true }),
    ).toBeVisible();
    f.authStates[`local-${tool}`] = "unknown";
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Work Claude", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Local CLI", exact: true }),
    ).toHaveCount(0);
  });

for (const tool of ["claude", "codex", "opencode"])
  test(`new managed ${tool} remains visible before login`, async ({ page }) => {
    const f = await fixture(page);
    f.state.tools = [{ id: tool, name: tool, installed: true }];
    f.state.accounts = [
      {
        id: `managed-${tool}`,
        name: "New account",
        tool,
        kind: "managed",
        hasSecret: false,
      },
    ];
    f.authStates[`managed-${tool}`] = "unauthenticated";
    await page.goto(baseURL + "/accounts");
    const card = page.locator(".account-card");
    await expect(
      card.getByRole("heading", { name: "New account", exact: true }),
    ).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Anmelden", exact: true }),
    ).toBeEnabled();
  });

test("local login and logout update without reloading the accounts page", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.clock.install();
  await page.goto(baseURL + "/accounts");
  await expect(page.getByText("Angemeldet", { exact: true })).toBeVisible();
  const local = page.getByRole("heading", { name: "Server Claude", exact: true });
  await expect(local).toHaveCount(0);
  f.authStates["local-claude"] = "authenticated";
  await page.clock.fastForward(11000);
  await expect(local).toBeVisible();
  f.authStates["local-claude"] = "unauthenticated";
  await page.clock.fastForward(11000);
  await expect(local).toHaveCount(0);
});
