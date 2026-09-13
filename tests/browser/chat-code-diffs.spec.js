import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import {
  normalizeClaude,
  normalizeCodex,
  normalizeOpenCode,
} from "../../server/features/chat/history-parsers.js";
const before = "/* multiline\n * comment */\nconst value = 1;\n";
const after =
  "/* multiline\n * comment */\nconst value = 2;\n" +
  Array.from(
    { length: 220 },
    (_, i) => `const line${i} = "${i === 100 ? "wide ".repeat(100) : "hello"}";`,
  ).join("\n");
function message(provider) {
  const input = { file_path: "src/example.ts", old_string: before, new_string: after };
  if (provider === "claude")
    return normalizeClaude([
      {
        type: "assistant",
        message: { content: [{ id: "edit", type: "tool_use", name: "Edit", input }] },
      },
    ]).messages[0];
  if (provider === "opencode")
    return normalizeOpenCode({
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              id: "edit",
              type: "tool",
              tool: "edit",
              state: {
                status: "running",
                input: { filePath: input.file_path, oldString: before, newString: after },
              },
            },
          ],
        },
      ],
    }).messages[0];
  return normalizeCodex({
    turns: [
      {
        items: [
          {
            id: "edit",
            type: "fileChange",
            status: "inProgress",
            changes: [
              {
                path: input.file_path,
                kind: { type: "update" },
                diff: `@@ -1,3 +1,223 @@\n${before
                  .trimEnd()
                  .split("\n")
                  .map((s) => "-" + s)
                  .join("\n")}\n${after
                  .split("\n")
                  .map((s) => "+" + s)
                  .join("\n")}\n`,
              },
            ],
          },
        ],
      },
    ],
  }).messages[0];
}
for (const locale of ["de-DE", "en-GB"]) {
  test.describe(locale, () => {
    test.use({ locale });
    for (const provider of ["claude", "codex", "opencode"])
      test(`${provider} code edits retain syntax, state and bounded mobile layout`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await operationsFixture(page);
        const item = message(provider);
        const data = {
          availability: "ready",
          providerSessionId: "native",
          history: { generation: "one" },
          tasks: [],
          messages: [{ id: "u", role: "user", text: "Update the code" }, item],
        };
        const publish = await mockChatStream(page, () => data);
        await page.goto("/sessions/fixture-session/chat");
        await page.locator(".chat-tool-group > summary").click();
        const tool = page.locator(".chat-tool");
        await tool.locator(":scope > summary").click();
        await expect(tool.locator(".tool-diff-row").first()).toBeVisible();
        expect(await tool.locator(".tool-diff-row").count()).toBeLessThanOrEqual(7);
        await expect(
          tool.locator(".hljs-comment").filter({ hasText: "comment" }).first(),
        ).toBeVisible();
        await expect(tool.locator(".is-remove .tool-diff-marker").first()).toHaveText(
          "−",
        );
        const en = locale === "en-GB";
        const expand = tool.getByRole("button", {
          name: en ? "Show more lines" : "Weitere Zeilen anzeigen",
          exact: true,
        });
        await expand.focus();
        await page.keyboard.press("Enter");
        await expect(tool.locator(".is-add .hljs-keyword").first()).toHaveText("const");
        await expect(tool).toContainText("line100");
        await expect(tool).not.toContainText("line219");
        const scroll = tool.locator(".tool-diff-scroll");
        expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
        item.status = "failed";
        await publish();
        await expect(tool.locator(":scope > summary")).toContainText(
          en ? "Failed" : "Fehlgeschlagen",
        );
        await expect(tool).toContainText("line100");
        expect(await tool.count()).toBe(1);
        await tool
          .getByRole("button", { name: en ? "Show more" : "Mehr anzeigen", exact: true })
          .click();
        await expect(tool).toContainText("line219");
        await tool.locator(".tool-change-raw > summary").click();
        await expect(tool.locator(".tool-change-raw .tool-output")).toBeVisible();
        await tool.locator(".tool-change-raw > summary").click();
        await tool
          .getByRole("button", {
            name: en ? "Collapse to eight lines" : "Auf acht Zeilen kürzen",
            exact: true,
          })
          .click();
        if (en) {
          await tool.screenshot({
            path: test.info().outputPath(`code-diff-${provider}-mobile.png`),
          });
          await page.setViewportSize({ width: 1280, height: 900 });
          await tool.screenshot({
            path: test.info().outputPath(`code-diff-${provider}-desktop.png`),
          });
        }
        await page.reload();
        await page.locator(".chat-tool-group > summary").click();
        await tool.locator(":scope > summary").click();
        await expect(tool.locator(".tool-change-heading strong")).toHaveText(
          "src/example.ts",
        );
        await expect(tool.locator(":scope > summary")).toContainText(
          en ? "Failed" : "Fehlgeschlagen",
        );
      });
  });
}
