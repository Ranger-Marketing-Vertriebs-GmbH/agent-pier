import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";

const call = (id, status, text) => ({
  id,
  role: "tool",
  toolName: "mcp__rea__process_attach",
  status,
  text,
});
const denied = "attach failed: error: EPERM: operation not permitted (pid 4711)";

function transcript() {
  return {
    availability: "ready",
    providerSessionId: "native",
    history: { generation: "one" },
    tasks: [],
    messages: [
      { id: "u", role: "user", text: "Attach to the process" },
      call("denied", "failed", denied),
      call("other", "failed", "Error: connection refused"),
    ],
  };
}

async function openTools(page) {
  await page.goto("/sessions/fixture-session/chat");
  await page.locator(".chat-tool-group > .activity-row-head").click();
  return page.locator(".chat-tool");
}

for (const [locale, blocked, hint, failed] of [
  ["en-GB", "Likely blocked by the sandbox", /nono sandbox profile research/, "Failed"],
  [
    "de-DE",
    "Wahrscheinlich von der Sandbox blockiert",
    /nono-Sandbox-Profil research/,
    "Fehlgeschlagen",
  ],
]) {
  test.describe(locale, () => {
    test.use({ locale });

    for (const width of [1280, 390])
      test(`a denied tool call in a sandboxed session names the sandbox at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await operationsFixture(page, {
          tool: "claude",
          session: { sandbox: { profile: "research" } },
        });
        await mockChatStream(page, transcript);
        const tools = await openTools(page);
        const first = tools.filter({ hasText: "EPERM" }).first();
        await expect(tools.first().locator("summary small")).toHaveText(blocked);
        await expect(tools.nth(1).locator("summary small")).toHaveText(failed);
        await tools.first().locator("summary").click();
        await expect(tools.first().getByText(hint)).toBeVisible();
        await expect(first).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
        if (locale === "en-GB")
          await tools
            .first()
            .screenshot({ path: test.info().outputPath(`sandbox-denial-${width}.png`) });
      });

    test("the same failure without a sandbox stays a plain failure", async ({ page }) => {
      await operationsFixture(page, { tool: "claude" });
      await mockChatStream(page, transcript);
      const tools = await openTools(page);
      await expect(tools.first().locator("summary small")).toHaveText(failed);
      await tools.first().locator("summary").click();
      await expect(tools.first().getByText(hint)).toHaveCount(0);
    });
  });
}
