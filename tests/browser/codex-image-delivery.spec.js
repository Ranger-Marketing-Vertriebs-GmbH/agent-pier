import { test, expect } from "@playwright/test";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);
for (const language of ["de-DE", "en-GB"]) {
  test.describe(language, () => {
    test.use({ locale: language, viewport: { width: 390, height: 844 } });
    for (const text of ["What is wrong with this screenshot?", ""]) {
      test(`Codex ${text ? "text and image" : "image-only"} appears once after native history and reload`, async ({
        page,
      }, testInfo) => {
        const english = language === "en-GB";
        const directory = "/tmp/agentpier-fixture/uploads";
        const file = `${directory}/screenshot.png`;
        const session = {
          id: "image",
          accountId: "account",
          tool: "codex",
          createdAt: "fixture",
          name: "Image chat",
          cwd: "/workspace",
          status: "running",
          attachments: { directory },
        };
        let messages = [],
          submits = 0,
          startedAt;
        const snapshot = () => ({
          availability: "ready",
          providerSessionId: "native-thread",
          messages,
          tasks: [],
          nativeInput: {
            generation: "launch",
            providerSessionId: "native-thread",
            queue: [],
          },
        });
        const publish = await mockChatStream(page, snapshot);
        await page.route("**/api/**", async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === "/api/state")
            return route.fulfill({
              json: {
                tools: [{ id: "codex", name: "Codex", installed: true }],
                sessions: [session],
                accounts: [],
                home: "/workspace",
              },
            });
          if (url.pathname.endsWith("/chat")) return route.fulfill({ json: snapshot() });
          if (url.pathname.endsWith("/chat/attachments"))
            return route.fulfill({ json: { name: "screenshot.png", path: file } });
          if (url.pathname.endsWith("/input")) {
            submits++;
            startedAt = Date.now();
            const body = route.request().postDataJSON();
            expect(body.text).toBe([text, file].filter(Boolean).join("\n"));
            return route.fulfill({
              json: {
                deliveryId: body.deliveryId,
                status: "handed-off",
                observation: {
                  generation: "launch",
                  providerSessionId: "native-thread",
                  startedAt,
                  hash: "image-body",
                  baseline: [],
                },
              },
            });
          }
          return route.fulfill({ json: {} });
        });
        await page.goto(`${baseURL}/sessions/image/chat`);
        if (text)
          await page
            .getByLabel(english ? "Message" : "Nachricht", { exact: true })
            .fill(text);
        await page.setInputFiles('input[type="file"]', {
          name: "screenshot.png",
          mimeType: "image/png",
          buffer: png,
        });
        await expect(
          page.getByRole("listitem").filter({ hasText: "screenshot.png" }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: english ? "Send" : "Senden", exact: true })
          .click();
        await expect(page.locator(".chat-delivery-message")).toContainText(
          english ? "Sent to TUI" : "An TUI gesendet",
        );
        // A same-text row with a different image must not swallow this upload.
        messages = [
          {
            id: "different",
            role: "user",
            text: `[Image #1] ${text}`,
            timestamp: startedAt + 1,
            imageInput: { text, paths: [["/tmp/other.png"]] },
          },
        ];
        await publish();
        await expect(page.locator(".chat-message.user")).toHaveCount(2);
        messages = [
          { ...messages[0], id: "native-user", imageInput: { text, paths: [[file]] } },
        ];
        await publish();
        const badge = page.locator(".chat-native-delivery");
        await expect(page.locator(".chat-message.user")).toHaveCount(1);
        await expect(page.locator(".chat-delivery-message")).toHaveCount(0);
        await expect(badge).toContainText(
          english ? "Accepted by CLI" : "Von der CLI übernommen",
        );
        await page.reload();
        await expect(page.locator(".chat-message.user")).toHaveCount(1);
        await expect(badge).toContainText(
          english ? "Accepted by CLI" : "Von der CLI übernommen",
        );
        expect(submits).toBe(1);
        if (english && text)
          await page
            .locator(".chat-main")
            .screenshot({ path: testInfo.outputPath("codex-image-chat-mobile.png") });
        // A paged-out native row must not resurrect the saved upload card.
        messages = [];
        await publish();
        await expect(page.locator(".chat-message.user")).toHaveCount(0);
        await page.reload();
        await expect(page.locator(".chat-delivery-message")).toHaveCount(0);
        expect(submits).toBe(1);
      });
    }
  });
}
