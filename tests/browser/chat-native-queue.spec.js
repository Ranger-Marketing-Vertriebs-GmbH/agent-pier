import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

for (const language of ["de-DE", "en-GB"]) {
  test.describe(language, () => {
    test.use({ locale: language, viewport: { width: 390, height: 844 } });
    for (const tool of ["codex", "claude", "opencode"]) {
      test(`${tool}: streamed queue state stays attached to the message through history and reload`, async ({
        page,
      }, testInfo) => {
        const english = language === "en-GB";
        const session = {
          id: "queue",
          accountId: "account",
          tool,
          createdAt: "fixture",
          name: "Native queue",
          cwd: "/workspace",
          status: "running",
        };
        const text = "Please also check the mobile layout.";
        const hash = createHash("sha256")
          .update(JSON.stringify([text, true]))
          .digest("hex");
        let startedAt,
          providerSessionId = "native-thread";
        let messages = [],
          queue = [],
          submits = 0;
        const snapshot = () => ({
          availability: "ready",
          providerSessionId,
          messages,
          tasks: [],
          nativeInput: {
            generation: "launch",
            providerSessionId: "native-thread",
            queue,
          },
        });
        const publish = await mockChatStream(page, snapshot);
        await page.route("**/api/**", async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === "/api/state")
            return route.fulfill({
              json: {
                tools: [{ id: tool, name: tool, installed: true }],
                sessions: [session],
                accounts: [],
                home: "/workspace",
              },
            });
          if (url.pathname.endsWith("/chat")) return route.fulfill({ json: snapshot() });
          if (url.pathname.endsWith("/input")) {
            submits++;
            startedAt = Date.now();
            const body = route.request().postDataJSON();
            return route.fulfill({
              json: {
                deliveryId: body.deliveryId,
                status: "handed-off",
                observation: {
                  startedAt,
                  generation: "launch",
                  providerSessionId: "native-thread",
                  hash,
                  baseline: [],
                },
              },
            });
          }
          return route.fulfill({ json: {} });
        });
        await page.goto(`${baseURL}/sessions/queue/chat`);
        await page
          .getByLabel(english ? "Message" : "Nachricht", { exact: true })
          .fill(text);
        await page
          .getByRole("button", { name: english ? "Send" : "Senden", exact: true })
          .click();
        await expect(page.locator(".chat-delivery-message")).toContainText(
          english ? "Sent to TUI" : "An TUI gesendet",
        );
        queue = [hash];
        if (tool === "opencode")
          messages = [
            { id: "native-user", role: "user", text, timestamp: startedAt + 1 },
          ];
        await publish();
        const badge = page.locator(".chat-native-delivery");
        await expect(badge).toHaveCount(1);
        await expect(badge).toContainText(
          english ? "In the CLI queue" : "In der CLI-Warteschlange",
        );
        await expect(
          page.getByRole("button", {
            name: english ? "Deliver again" : "Erneut zustellen",
            exact: true,
          }),
        ).toHaveCount(0);
        await page.reload();
        await expect(badge).toHaveCount(1);
        await expect(badge).toContainText(
          english ? "In the CLI queue" : "In der CLI-Warteschlange",
        );
        expect(submits).toBe(1);
        if (english && tool === "opencode")
          await page
            .locator(".chat-main")
            .screenshot({ path: testInfo.outputPath("native-queue-mobile.png") });
        queue = [];
        await publish();
        await expect(badge).toHaveCount(0); // Disappearance alone is not consumption.
        messages = [
          {
            id: "native-user",
            role: "user",
            text,
            timestamp: startedAt + 1,
            ...(tool === "opencode" ? { inputConsumed: true } : {}),
          },
        ];
        await publish();
        await expect(badge).toHaveCount(1);
        await expect(badge).toContainText(
          english ? "Accepted by CLI" : "Von der CLI übernommen",
        );
        expect(submits).toBe(1);
        providerSessionId = "other-conversation";
        await publish();
        await expect(badge).toHaveCount(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
      });
    }
  });
}
