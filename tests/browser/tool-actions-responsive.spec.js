import { test, expect } from "@playwright/test";

async function fixture(page) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const calls = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      calls.push({ pathname, body: request.postDataJSON() });
      return route.fulfill({ status: 409, json: { error: "Request captured" } });
    }
    const json =
      pathname === "/api/state"
        ? {
            tools: [
              { id: "codex", name: "Codex", installed: true },
              { id: "shell", name: "Shell", installed: true },
            ],
            accounts: [
              { id: "local-codex", tool: "codex", name: "Codex", kind: "local" },
              { id: "local-shell", tool: "shell", name: "Shell", kind: "local" },
            ],
            sessions: [],
            home: "/tmp",
            defaultCwd: "/tmp",
          }
        : pathname === "/api/tool-installations"
          ? {
              installations: [
                {
                  tool: "codex",
                  status: "idle",
                  updateAvailable: true,
                  updateCommand: "codex update",
                },
              ],
            }
          : { profiles: [], accesses: [] };
    return route.fulfill({ json });
  });
  await page.goto("/");
  return calls;
}

for (const width of [390, 780, 1440]) {
  test(`Codex start and update remain distinct and clickable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const calls = await fixture(page);
    const card = page
      .locator(".tool-card")
      .filter({ has: page.getByRole("heading", { name: "Codex", exact: true }) });
    const start = card.getByRole("button", { name: "Start session", exact: true });
    const update = card.getByRole("button", { name: "Update CLI", exact: true });
    const a = await start.boundingBox(),
      b = await update.boundingBox();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(
      a.y + a.height <= b.y ||
        b.y + b.height <= a.y ||
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x,
    ).toBe(true);
    expect(
      await update.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThan(0);
    await start.click();
    await expect(
      page.getByRole("dialog", { name: "New session", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await update.click();
    const modal = page.getByRole("dialog", { name: "Update Codex", exact: true });
    await modal.getByRole("button", { name: "Update now", exact: true }).click();
    await expect(modal.getByRole("alert")).toHaveText("Request captured");
    expect(calls).toEqual([{ pathname: "/api/tools/codex/update", body: {} }]);
    if (width === 390) {
      await page.getByRole("button", { name: "Close dialog", exact: true }).click();
      await page.screenshot({
        path: "/tmp/agentpier-tool-actions-mobile.png",
        fullPage: true,
      });
    }
  });
}

test("the general launch dialog can switch between Codex and Shell and launch the shell", async ({
  page,
}) => {
  const calls = await fixture(page);
  await page.locator(".hero-cta").click();
  const modal = page.getByRole("dialog", { name: "New session", exact: true });
  const cli = modal.getByRole("combobox", { name: "CLI", exact: true });
  await cli.selectOption("shell");
  await expect(modal.getByLabel("Launch mode", { exact: true })).toHaveCount(0);
  await expect(modal.getByRole("checkbox", { name: /AgentBus/ })).toHaveCount(0);
  await cli.selectOption("codex");
  await expect(modal.getByLabel("Launch mode", { exact: true })).toBeVisible();
  await cli.selectOption("shell");
  await modal.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(modal.getByRole("alert")).toHaveText("Request captured");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    pathname: "/api/sessions",
    body: {
      accountId: "local-shell",
      launchMode: "default",
      agentbus: false,
      agentpierTools: false,
    },
  });
});
