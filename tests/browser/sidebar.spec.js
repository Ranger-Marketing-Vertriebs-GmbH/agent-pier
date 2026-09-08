import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
async function fixture(page) {
  const sessions = ["working", "idle", "waiting", "unknown", "stopped"].map(
    (activity, index) => ({
      id: `status-${activity}`,
      name: `Projekt ${index + 1}`,
      tool: "codex",
      accountId: "local-codex",
      cwd: `/work/project-${index}`,
      status: activity === "stopped" ? "stopped" : "running",
      activity: {
        state: activity,
        label: {
          working: "Arbeitet",
          idle: "Bereit",
          waiting: "Wartet auf Freigabe",
          unknown: "Aktivität unbekannt",
          stopped: "Beendet",
        }[activity],
      },
    }),
  );
  sessions.push({
    id: "terminal",
    name: "Lokale Shell",
    tool: "shell",
    accountId: "local-shell",
    cwd: "/work",
    status: "running",
    activity: { state: "working", label: "Arbeitet" },
  });
  const writes = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(path);
    const data =
      path === "/api/state"
        ? {
            tools: [],
            accounts: [
              { id: "local-codex", tool: "codex", name: "Lokal", kind: "local" },
            ],
            sessions,
            home: "/work",
          }
        : path.endsWith("/chat")
          ? { availability: "ready", messages: [], tasks: [] }
          : path.endsWith("/models")
            ? { picker: null, pending: false }
            : {};
    await route.fulfill({ json: data });
  });
  await page.routeWebSocket("**/api/sessions/*/terminal", (ws) =>
    ws.send(JSON.stringify({ type: "output", data: "Fixture" })),
  );
  return { sessions, writes };
}
test("sidebar groups shorten the menu and remember explicit toggles across reload", async ({
  page,
}) => {
  await fixture(page);
  await page.goto(base);
  const management = page.getByRole("button", { name: "Verwaltung", exact: true }),
    sessions = page.getByRole("button", { name: "Sitzungen", exact: true });
  await expect(management).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Konten", exact: true })).toBeHidden();
  await expect(sessions).toHaveAttribute("aria-expanded", "true");
  await sessions.click();
  await expect(page.locator(".session-list")).toBeHidden();
  await management.click();
  await expect(page.getByRole("button", { name: "Konten", exact: true })).toBeVisible();
  await page.reload();
  await expect(management).toHaveAttribute("aria-expanded", "true");
  await expect(sessions).toHaveAttribute("aria-expanded", "false");
  await management.click();
  await page.reload();
  await expect(management).toHaveAttribute("aria-expanded", "false");
  await page.goto(base + "/accounts");
  await expect(management).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Konten", exact: true })).toHaveClass(
    /selected/,
  );
  await page.goto(base + "/sessions/status-working/terminal");
  await expect(sessions).toHaveAttribute("aria-expanded", "true");
});
for (const mobile of [false, true])
  test(`activity labels distinguish working, unknown and Shell (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const { sessions, writes } = await fixture(page);
    await page.goto(base);
    if (mobile) {
      await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
      await expect
        .poll(async () => Math.round((await page.locator(".sidebar").boundingBox()).x))
        .toBe(0);
    }
    const row = (name) =>
      page
        .locator(".session-item")
        .filter({ has: page.getByText(name, { exact: true }) });
    await expect(row("Projekt 1")).toContainText("Arbeitet");
    await expect(row("Projekt 1").locator(".activity-dot")).toHaveClass(/working/);
    await expect(row("Projekt 2")).toContainText("Bereit");
    await expect(row("Projekt 3")).toContainText("Wartet auf Freigabe");
    await expect(row("Projekt 4")).toContainText("Aktivität unbekannt");
    await expect(row("Projekt 5")).toContainText("Beendet");
    await expect(row("Lokale Shell")).toContainText("Terminal aktiv");
    await expect(row("Lokale Shell")).not.toContainText("Arbeitet");
    await page.screenshot({
      path: `/tmp/agentpier-sidebar-${mobile ? "mobile" : "desktop"}.png`,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    sessions[0].activity = { state: "waiting", label: "Wartet auf Freigabe" };
    await expect(row("Projekt 1")).toContainText("Wartet auf Freigabe");
    await row("Projekt 1").click();
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Lesemodus", exact: true }),
    ).toHaveCount(0);
    expect(writes).toEqual([]);
  });
