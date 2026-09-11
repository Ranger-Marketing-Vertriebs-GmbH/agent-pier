import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";

const command = (id, status = "completed") => ({
  id,
  role: "tool",
  toolName: "Shell",
  status,
  text: `Output for ${id}\n${"long-command-".repeat(30)}`,
});

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(locale, () => {
    test.use({ locale });
    test("tool runs collapse between messages and stay open across streamed updates", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await operationsFixture(page);
      const data = {
        availability: "ready",
        providerSessionId: "native",
        history: { generation: "one" },
        tasks: [],
        messages: [
          { id: "u", role: "user", text: "Check the workspace" },
          command("first"),
          command("second"),
          command("third", "failed"),
          { id: "a", role: "assistant", text: "I found an issue and will check it." },
          command("fourth", "running"),
        ],
      };
      const publish = await mockChatStream(page, () => data);
      await page.goto("/sessions/fixture-session/chat");
      const groups = page.locator(".chat-tool-group");
      await expect(groups).toHaveCount(2);
      await expect(groups.first().locator(":scope > summary")).toContainText(
        locale === "de-DE" ? "3 Aufrufe" : "3 calls",
      );
      await expect(groups.first().locator(":scope > summary")).toContainText(
        locale === "de-DE" ? "1 fehlgeschlagen" : "1 failed",
      );
      await expect(groups.last().locator(":scope > summary")).toContainText(
        locale === "de-DE" ? "Agent arbeitet" : "Agent is working",
      );
      await expect(groups.last().locator(".tool-group-spinner")).toHaveCount(1);
      await expect(groups.first().locator(".chat-tool").first()).not.toBeVisible();
      await groups.first().locator(":scope > summary").focus();
      await page.keyboard.press("Enter");
      await groups.first().locator(".chat-tool summary").first().click();
      await expect(groups.first().locator("pre").first()).toBeVisible();
      data.messages.push(command("fifth", "running"));
      await publish();
      await expect(groups.last().locator(":scope > summary")).toContainText(
        locale === "de-DE" ? "2 Aufrufe" : "2 calls",
      );
      await expect(groups.first()).toHaveAttribute("open", "");
      await expect(groups.first().locator(".chat-tool").first()).toHaveAttribute(
        "open",
        "",
      );
      data.observability = { stale: true };
      await publish();
      await expect(page.locator(".tool-group-spinner")).toHaveCount(0);
      data.observability = { stale: false };
      data.messages[5].status = "completed";
      data.messages[6].status = "completed";
      data.messages.push({ id: "done", role: "assistant", text: "Checks complete." });
      await publish();
      await expect(page.locator(".tool-group-spinner")).toHaveCount(0);
      await expect(groups).toHaveCount(2);
      await groups.first().locator(":scope > summary").click();
      await page.screenshot({ path: test.info().outputPath("grouped-tools.png") });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      data.messages.unshift(
        { id: "older-user", role: "user", text: "Previous task" },
        command("older-tool"),
        { id: "older-answer", role: "assistant", text: "Previous result" },
      );
      await publish();
      await expect(groups).toHaveCount(3);
      await expect(groups.nth(1).locator(":scope > summary")).toContainText(
        locale === "de-DE" ? "3 Aufrufe" : "3 calls",
      );
      // A new native history must not inherit disclosure state from the old one.
      data.history.generation = "two";
      data.messages = [
        { id: "new", role: "user", text: "New conversation" },
        command("first"),
      ];
      await publish();
      await expect(groups).toHaveCount(1);
      await expect(groups.first()).not.toHaveAttribute("open");
    });
  });
}
