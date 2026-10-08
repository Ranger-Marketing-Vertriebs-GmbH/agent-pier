import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);
const directory = "/workspace/.uploads";
test.use({ locale: "en-GB" });

// Synthetic transcript: Claude Code records a message queued while it was busy,
// with re-encoded images, as an array-form queued_command and no upload paths.
test("an image message queued while Claude is busy is confirmed and shown with its image labels", async ({
  page,
}) => {
  const { normalizeClaude } =
    await import("../../server/features/chat/history-parsers.js");
  const session = {
    id: "queued-images",
    accountId: "account",
    tool: "claude",
    createdAt: "fixture",
    name: "Queued images",
    cwd: "/workspace",
    status: "running",
    attachments: { directory },
  };
  const names = ["one.png", "two.png", "three.png", "four.png"];
  const paths = names.map((name) => `${directory}/${name}`);
  const authored = "Compare these four layouts";
  let messages = [],
    startedAt,
    sent;
  const snapshot = () => ({
    availability: "ready",
    providerSessionId: "native-thread",
    messages,
    tasks: [],
    nativeInput: { generation: "launch", providerSessionId: "native-thread", queue: [] },
  });
  const publish = await mockChatStream(page, snapshot);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "claude", name: "Claude Code", installed: true }],
          sessions: [session],
          accounts: [],
          home: "/workspace",
        },
      });
    if (url.pathname.endsWith("/chat")) return route.fulfill({ json: snapshot() });
    if (url.pathname.endsWith("/chat/attachments")) {
      const { name } = request.postDataJSON();
      return route.fulfill({ json: { name, path: `${directory}/${name}` } });
    }
    if (url.pathname.endsWith("/input")) {
      const body = request.postDataJSON();
      sent = body.text;
      startedAt = Date.now();
      return route.fulfill({
        json: {
          deliveryId: body.deliveryId,
          status: "handed-off",
          observation: {
            startedAt,
            generation: "launch",
            providerSessionId: "native-thread",
            hash: createHash("sha256")
              .update(JSON.stringify([body.text, true]))
              .digest("hex"),
            baseline: [],
          },
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${baseURL}/sessions/queued-images/chat`);
  await page.getByLabel("Message", { exact: true }).fill(authored);
  await page.setInputFiles(
    'input[type="file"]',
    names.map((name) => ({ name, mimeType: "image/png", buffer: png })),
  );
  for (const name of names)
    await expect(page.getByRole("listitem").filter({ hasText: name })).toHaveCount(1);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const card = page.locator(".chat-delivery-message");
  await expect(card).toContainText("Sent to TUI · awaiting CLI confirmation");
  expect(sent).toBe([authored, ...paths].join("\n"));

  const image = { type: "image", source: { type: "base64", media_type: "image/png" } };
  messages = normalizeClaude([
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: new Date().toISOString(),
    },
    {
      type: "attachment",
      uuid: "queued-attachment",
      timestamp: new Date(startedAt + 1000).toISOString(),
      attachment: {
        type: "queued_command",
        commandMode: "prompt",
        origin: { kind: "human" },
        source_uuid: "queued-source",
        imagePasteIds: [5, 6, 7, 8],
        prompt: [
          { type: "text", text: `[Image #5][Image #6][Image #7][Image #8] ${authored}` },
          image,
          image,
          image,
          image,
        ],
      },
    },
  ]).messages;
  await publish();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".chat-delivery-status")).toHaveCount(0);
  await expect(page.locator(".chat-native-delivery")).toContainText("Accepted by CLI");
  // The row shows the recorded text, the same on every device and after the
  // delivery notice is gone.
  const mine = page.getByRole("article", { name: "Your message", exact: true });
  const recorded = `[Image #5][Image #6][Image #7][Image #8] ${authored}`;
  await expect(mine).toHaveCount(1);
  await expect(mine).toHaveText(recorded);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(mine).toHaveCount(1);
  await expect(mine).toHaveText(recorded);
  await expect(page.locator(".chat-delivery-message")).toHaveCount(0);
});
