import { test, expect } from "@playwright/test";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-GB", viewport: { width: 390, height: 650 } });
for (const tool of ["codex", "claude"]) {
  test(`${tool}: current native warnings are visible once, clear and respect conversation identity`, async ({
    page,
  }) => {
    const session = {
      id: "warnings",
      accountId: "fixture",
      tool,
      cwd: "/fixture",
      status: "running",
      name: "Limit warnings",
    };
    const warning =
      tool === "codex"
        ? "Heads up, you have less than 10% of your weekly limit left. Run /status for a breakdown."
        : "You've used 90% of your weekly limit · resets Oct 4 at 12pm";
    const data = {
      availability: "ready",
      providerSessionId: "thread",
      messages: [],
      tasks: [],
      nativeInput: {
        generation: "launch",
        providerSessionId: "thread",
        warnings: [warning],
      },
    };
    const publish = await mockChatStream(page, () => data);
    let inputs = 0;
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      let result = {};
      if (pathname === "/api/state")
        result = {
          sessions: [session],
          accounts: [],
          tools: [{ id: tool, name: tool, installed: true }],
          home: "/fixture",
        };
      if (pathname.endsWith("/chat")) result = data;
      if (pathname.endsWith("/input")) inputs++;
      await route.fulfill({ json: result });
    });
    await page.goto(baseURL + "/sessions/warnings/chat");
    const notice = page.getByRole("status", { name: "Usage limit warning" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(warning);
    await page.locator(".chat-composer textarea").fill("Keep this draft");
    await publish();
    await publish();
    await expect(notice).toHaveCount(1);
    await expect(page.getByText(warning, { exact: true })).toHaveCount(1);
    await expect(notice).toHaveCSS("overflow-y", "auto");
    const box = await notice.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(650);
    if (tool === "claude")
      await page.screenshot({ path: "docs/screenshots/chat-limit-warning-mobile.png" });
    data.nativeInput.providerSessionId = "previous-thread";
    await publish();
    await expect(notice).toHaveCount(0);
    data.nativeInput.providerSessionId = "thread";
    await publish();
    await expect(notice).toBeVisible();
    data.nativeInput.warnings = [];
    await publish();
    await expect(notice).toHaveCount(0);
    data.nativeInput.warnings = [warning];
    await publish();
    await expect(notice).toBeVisible();
    data.nativeInput = null;
    await publish();
    await expect(notice).toHaveCount(0);
    await expect(page.locator(".chat-composer textarea")).toHaveValue("Keep this draft");
    expect(inputs).toBe(0);
  });
}
