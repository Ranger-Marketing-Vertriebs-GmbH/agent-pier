import { test, expect } from "@playwright/test";
import { summary } from "../helpers/system-status-fixture.js";

const legacy = [
  { id: "s1", name: "Fix the login flow" },
  { id: "s2", name: "Review the API docs" },
];

// Both notices read their sessions from polled answers; `current.sessions` drives them.
async function routeLegacy(page, current) {
  await page.route("**/api/system-status", (route) =>
    route.fulfill({ json: { ...summary(), legacyTmux: { sessions: current.sessions } } }),
  );
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.sessions = legacy.map(({ id, name }) => ({
      id,
      name,
      tool: "codex",
      cwd: `/work/${id}`,
      status: "running",
      activity: { state: "idle", label: "Ready" },
    }));
    json.legacyTmux = { sessions: current.sessions };
    await route.fulfill({ response, json });
  });
}

test.describe("in English", () => {
  test.use({ locale: "en-GB" });

  test("both notices name the sessions on the old tmux server until none is left", async ({
    page,
  }) => {
    const current = { sessions: legacy };
    await routeLegacy(page, current);
    await page.goto("/");
    const start = page.getByRole("region", { name: "System status" }).getByRole("status");
    const sidebar = page.locator(".sidebar").getByRole("status");
    for (const notice of [start, sidebar]) {
      await expect(notice).toContainText("2 sessions still run on the old tmux server");
      await expect(notice).toContainText(
        "Stop these sessions when convenient; AgentPier then starts new sessions on the new server.",
      );
      await expect(
        notice.getByRole("list", { name: "Sessions on the old tmux server" }),
      ).toHaveText(/Fix the login flow\s*Review the API docs/);
    }
    current.sessions = [legacy[1]];
    for (const notice of [start, sidebar]) {
      await expect(notice).toContainText("1 session still runs on the old tmux server", {
        timeout: 12_000,
      });
      await expect(notice).toContainText("Stop this session when convenient");
      await expect(notice.getByRole("listitem")).toHaveText(["Review the API docs"]);
    }
    current.sessions = [];
    await expect(start).toHaveCount(0, { timeout: 12_000 });
    await expect(sidebar).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole("button", { name: /System status/ })).toBeVisible();
  });

  test("on a phone the notice stays inside the page width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routeLegacy(page, { sessions: legacy });
    await page.goto("/");
    await expect(
      page.getByRole("region", { name: "System status" }).getByRole("status"),
    ).toContainText("Review the API docs");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  });
});

test("the German notice uses the product terms", async ({ page }) => {
  await routeLegacy(page, { sessions: [legacy[0]] });
  await page.goto("/");
  const notice = page.getByRole("region", { name: "Systemstatus" }).getByRole("status");
  await expect(notice).toContainText("1 Session läuft noch auf dem alten tmux-Server");
  await expect(notice).toContainText(
    "Stoppe diese Session, wenn es dir passt; danach startet AgentPier neue Sessions auf dem neuen Server.",
  );
});
