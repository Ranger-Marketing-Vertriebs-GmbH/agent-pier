import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(locale, () => {
    test.use({ locale });
    for (const width of [1280, 390])
      test(`formatted tool output expands and survives streaming at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await operationsFixture(page);
        const cmd =
          'echo "Hello"\nprintf "second line"\n' +
          Array.from({ length: 220 }, (_, i) => `echo line-${i}`).join("\n");
        const message = {
          id: "call",
          role: "tool",
          toolName: "exec_command",
          status: "running",
          text:
            JSON.stringify({ cmd, workdir: "/workspace", yield_time_ms: 1000 }) +
            "\n\n<script>window.toolExecuted=true</script>\nRESULT_END",
        };
        const data = {
          availability: "ready",
          providerSessionId: "native",
          history: { generation: "one" },
          tasks: [],
          messages: [{ id: "u", role: "user", text: "Run the checks" }, message],
        };
        const publish = await mockChatStream(page, () => data);
        await page.goto("/sessions/fixture-session/chat");
        await page.locator(".chat-tool-group > summary").click();
        const tool = page.locator(".chat-tool");
        await tool.locator("summary").click();
        await expect(tool.locator("pre").first()).toContainText('echo "Hello"\nprintf');
        await expect(tool.locator(".hljs-built_in").first()).toHaveText("echo");
        await expect(tool).not.toContainText("RESULT_END");
        expect(
          (await tool.locator(".tool-output-blocks").boundingBox()).height,
        ).toBeLessThanOrEqual(178);
        const en = locale === "en-GB";
        const expand = tool.getByRole("button", {
          name: en ? "Show more lines" : "Weitere Zeilen anzeigen",
          exact: true,
        });
        await expand.focus();
        await page.keyboard.press("Enter");
        await expect(tool).toContainText("line-150");
        await expect(tool).not.toContainText("RESULT_END");
        await tool
          .getByRole("button", { name: en ? "Show more" : "Mehr anzeigen", exact: true })
          .click();
        await expect(tool).toContainText("RESULT_END");
        expect(await page.evaluate(() => window.toolExecuted)).toBeUndefined();
        message.text += "\nSTREAM_END";
        message.status = "completed";
        await publish();
        await expect(tool).toContainText("STREAM_END");
        await tool
          .getByRole("button", {
            name: en ? "Collapse to eight lines" : "Auf acht Zeilen kürzen",
            exact: true,
          })
          .click();
        await expect(tool).not.toContainText("RESULT_END");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
        if (en)
          await tool.screenshot({
            path: test.info().outputPath(`tool-output-${width}.png`),
          });
        message.text = "one very long line " + "long-value ".repeat(150);
        await publish();
        await expect(expand).toBeVisible();
        await expand.click();
        await expect(tool.locator("pre")).toHaveText(message.text);
      });
  });
}
