import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SHOT =
  "/private/tmp/claude-501/-Users-d-kaulig-Projects-agent-pier/57444b1d-ee52-4ebe-9641-34847aaddfbf/scratchpad/truncated-tool-iphone.png";

async function serve(page, language, tool) {
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  await operationsFixture(page);
  const data = {
    availability: "ready",
    providerSessionId: "native",
    history: { generation: "one" },
    tasks: [],
    messages: [{ id: "u", role: "user", text: "Run" }, tool],
  };
  await mockChatStream(page, () => data);
}

const truncatedTool = {
  id: "big",
  role: "tool",
  toolName: "exec_command",
  status: "completed",
  text: "HEAD-START\n" + "h".repeat(12000),
  textTail: "t".repeat(4000) + "\nTAIL-END",
  truncated: { length: 300000, bytes: 300000 },
};

async function expand(page) {
  await page.goto("/sessions/fixture-session/chat");
  await page.locator(".chat-tool-group > summary").click();
  const tool = page.locator(".chat-tool");
  await tool.locator("summary").click();
  return tool;
}

test("truncated tool output loads in full on demand", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page, "en", { ...truncatedTool });
  await page.route("**/api/sessions/*/chat/messages/*/text", (route) =>
    route.fulfill({ json: { text: "FULL-OUTPUT-MARKER" } }),
  );
  const tool = await expand(page);
  await expect(tool).toContainText("HEAD-START");
  await expect(tool).toContainText(/KB omitted/);
  await expect(tool).toContainText("TAIL-END");
  const clipped = await tool.locator(".tool-output-blocks.from-end").evaluate((box) => {
    const end = [...box.querySelectorAll("pre")].at(-1).getBoundingClientRect();
    const frame = box.getBoundingClientRect();
    return end.bottom > frame.bottom + 1 || end.bottom < frame.top;
  });
  expect(clipped).toBe(false);
  const button = tool.getByRole("button", { name: /Load full output \(293 KB\)/ });
  await button.scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOT });
  await button.click();
  await expect(tool).toContainText("FULL-OUTPUT-MARKER");
  await expect(button).toHaveCount(0);
});

test("unavailable full output shows the error and keeps the button", async ({ page }) => {
  await serve(page, "en", { ...truncatedTool });
  const message = "This output is no longer available. Reload the chat to load it again.";
  await page.route("**/api/sessions/*/chat/messages/*/text", (route) =>
    route.fulfill({ status: 404, json: { error: message } }),
  );
  const tool = await expand(page);
  await tool.getByRole("button", { name: /Load full output/ }).click();
  await expect(tool.getByText(message)).toBeVisible();
  await expect(tool.getByRole("button", { name: /Load full output/ })).toBeVisible();
});

test("truncated output is localized in German", async ({ page }) => {
  await serve(page, "de", { ...truncatedTool });
  const tool = await expand(page);
  await expect(
    tool.getByRole("button", { name: /Vollständige Ausgabe laden/ }),
  ).toBeVisible();
  await expect(tool).toContainText(/KB ausgelassen/);
});

test("tool images load only after the row is opened", async ({ page }) => {
  await serve(page, "en", {
    id: "img",
    role: "tool",
    toolName: "view_image",
    status: "completed",
    text: "ok",
    images: [{ id: "a".repeat(64), path: "shot.png · 1" }],
  });
  let hits = 0;
  await page.route("**/api/sessions/*/chat/images/*", (route) => {
    hits += 1;
    return route.fulfill({ body: PNG, contentType: "image/png" });
  });
  await page.goto("/sessions/fixture-session/chat");
  await page.locator(".chat-tool-group > summary").click();
  const tool = page.locator(".chat-tool");
  await page.waitForTimeout(300);
  expect(hits).toBe(0);
  await tool.locator("summary").click();
  const open = tool.locator(".chat-image-open");
  await expect(open).toBeEnabled();
  expect(hits).toBeGreaterThan(0);
  await open.click();
  await expect(page.locator("dialog.chat-image-dialog")).toBeVisible();
});
